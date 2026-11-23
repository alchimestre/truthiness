import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProposal } from "./store.ts";
import { digest } from "./review.ts";

type Note = { path: string; excerpt: string };
type Blob = { path: string; oid: string; size: number };
type Leads = Map<string, Set<string>>;

const scanned = /\.(?:py|pyi|ts|tsx|js|jsx|go|rs|md|rst|toml)$/;
const declaration = /^(?:export\s+)?(?:async\s+)?(?:def|class|function|func|fn|interface|type)\s+\w/;
const heading = /^#{1,4}\s+\S/;
const maxNotes = 300;
const minExcerpt = 8;
const maxExcerpt = 160;

function sourceFiles(directory: string, revision: string) {
    const tree = checkout(directory, ["ls-tree", "-rlz", "--full-tree", revision]);
    if (tree === undefined) throw new Error("could not read checkout tree");
    const blobs = withoutExcluded(directory, tree.split("\0").flatMap(parseTreeEntry));
    const leads = scratchLeads(directory, blobs.map(blob => blob.path));
    const ordered = [...blobs.filter(blob => leads.has(blob.path)), ...blobs.filter(blob => !leads.has(blob.path))];
    const maxFiles = 200;
    const maxBytes = 8 * 1024 * 1024;
    const selected: Blob[] = [];
    let bytes = 0;
    for (const blob of ordered) {
        if (selected.length === maxFiles) break;
        if (bytes + blob.size > maxBytes) continue;
        selected.push(blob);
        bytes += blob.size;
    }
    return { sources: readBlobs(directory, selected, maxBytes), leads };
}

// `.gitattributes` lines like `bench/** -truthiness` keep fixtures and generated files out of seeded notes.
function withoutExcluded(directory: string, blobs: Blob[]): Blob[] {
    const root = checkout(directory, ["rev-parse", "--show-toplevel"])?.trim();
    if (!root || !blobs.length) return blobs;
    const result = spawnSync("git", ["--no-replace-objects", "-C", root, "check-attr", "-z", "--stdin", "truthiness"], {
        input: blobs.map(blob => `${blob.path}\0`).join(""), encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error("could not read truthiness attributes");
    const fields = result.stdout.split("\0");
    const excluded = new Set<string>();
    for (let index = 0; index + 2 < fields.length; index += 3) {
        if (fields[index + 2] === "unset") excluded.add(fields[index]);
    }
    return blobs.filter(blob => !excluded.has(blob.path));
}

function parseTreeEntry(entry: string): Blob[] {
    const separator = entry.indexOf("\t");
    if (separator < 0) return [];
    const metadata = /^100[0-7]{3} blob ([a-f0-9]+)\s+(\d+)$/.exec(entry.slice(0, separator));
    const path = entry.slice(separator + 1);
    if (!metadata || !scanned.test(path) || /[\p{Cc}\p{Cf}]/u.test(path)) return [];
    const size = Number(metadata[2]);
    const maxFileBytes = 256 * 1024;
    return size <= maxFileBytes ? [{ path, oid: metadata[1], size }] : [];
}

function readBlobs(directory: string, blobs: Blob[], maxBytes: number): Map<string, string> {
    const sources = new Map<string, string>();
    if (!blobs.length) return sources;
    const input = blobs.map(blob => `${blob.oid}\n`).join("");
    const result = spawnSync("git", ["--no-replace-objects", "-C", directory, "cat-file", "--batch"], {
        input, timeout: 5000, maxBuffer: maxBytes + blobs.length * 128,
    });
    if (result.status !== 0) throw new Error("could not read checkout blobs");
    const output = result.stdout;
    let offset = 0;
    for (const blob of blobs) {
        const end = output.indexOf(10, offset);
        const header = output.toString("ascii", offset, end);
        if (header !== `${blob.oid} blob ${blob.size}`) throw new Error("unexpected Git blob header");
        const start = end + 1;
        offset = start + blob.size + 1;
        if (output[offset - 1] !== 10) throw new Error("incomplete Git blob");
        sources.set(blob.path, output.toString("utf8", start, offset - 1));
    }
    return sources;
}

function landmarks(sources: Map<string, string>, leads: Leads): Note[] {
    const perPath = Array.from(sources, ([path, content]) => notesIn(path, content, leads.get(path)));
    const notes: Note[] = [];
    for (let rank = 0; notes.length < maxNotes; rank++) {
        const round = perPath.map(list => list[rank]).filter(note => note !== undefined);
        if (!round.length) break;
        notes.push(...round.slice(0, maxNotes - notes.length));
    }
    return notes;
}

function notesIn(path: string, content: string, leads?: Set<string>): Note[] {
    if (content.includes("\0")) return [];
    const counts = new Map<string, number>();
    for (const line of content.split("\n")) {
        const excerpt = line.trim();
        if (excerpt.length < minExcerpt || excerpt.length > maxExcerpt || /[\p{Cc}\p{Cf}]/u.test(excerpt)) continue;
        if (leads?.has(excerpt) || declaration.test(excerpt) || heading.test(excerpt)) {
            counts.set(excerpt, (counts.get(excerpt) ?? 0) + 1);
        }
    }
    return [...counts].flatMap(([excerpt, count]) => count === 1 ? [{ path, excerpt }] : []);
}

function scratchLeads(directory: string, paths: string[]): Leads {
    const leads: Leads = new Map();
    const root = checkout(directory, ["rev-parse", "--show-toplevel"])?.trim();
    if (!root) return leads;
    const scratch = join(root, ".scratch");
    const tracked = new Set(paths);
    const directories = [scratch];
    const maxEntries = 300;
    const maxBytes = 64 * 1024;
    let visited = 0;
    while (directories.length && visited < maxEntries) {
        const directory = directories.shift()!;
        try {
            if (!lstatSync(directory).isDirectory()) continue;
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (++visited > maxEntries) break;
                const path = join(directory, entry.name);
                if (entry.isDirectory()) directories.push(path);
                if (!entry.isFile() || !/\.(?:md|rst|txt)$/.test(entry.name) || lstatSync(path).size > maxBytes) continue;
                collectLeads(readFileSync(path, "utf8"), tracked, leads);
            }
        } catch {
            continue;
        }
    }
    return leads;
}

function collectLeads(text: string, tracked: Set<string>, leads: Leads) {
    for (const word of text.matchAll(/[\w./-]+/g)) {
        const path = word[0].replace(/^\.\//, "").replace(/\.+$/, "");
        if (tracked.has(path) && !leads.has(path)) leads.set(path, new Set());
    }
    for (const line of text.split("\n")) {
        const citation = /^\s*`?([\w./-]+)`?:\s+(.+)$/.exec(line);
        if (!citation) continue;
        const path = citation[1].replace(/^\.\//, "");
        const excerpt = citation[2].trim().replace(/^`(.*)`$/, "$1");
        if (excerpt.length <= maxExcerpt) leads.get(path)?.add(excerpt);
    }
}

export function bootstrap(directory: string, revision: string, existing: Set<string>) {
    const { sources, leads } = sourceFiles(directory, revision);
    const batches: string[] = [];
    for (const note of landmarks(sources, leads)) {
        const records = provenance(note, revision);
        if (records.some(record => existing.has(record.id))) continue;
        const batch = records.map(record => `${JSON.stringify(record)}\n`).join("");
        try {
            parseProposal(batch);
            batches.push(batch);
        } catch (error) {
            if (!(error instanceof Error) || !error.message.endsWith("contains recognizable secret material")) throw error;
        }
    }
    return { batch: batches.join(""), sources };
}

function provenance(note: Note, revision: string) {
    const recorded = { recorded_at: new Date().toISOString(), recorded_by: "bootstrap-source-scanner" };
    const claimID = `note-${digest(JSON.stringify([note.path, note.excerpt])).slice(0, 20)}`;
    const evidenceID = `${claimID}-source-${revision.slice(0, 12)}`;
    return [
        { ...recorded, id: claimID, kind: "claim", text: `${note.path}: ${note.excerpt}`, scope: "repo", anchors: [{ path: note.path }], check: null },
        { ...recorded, id: evidenceID, kind: "observation", content: note.excerpt, source_ref: `${revision}:${note.path}`, captured_at: recorded.recorded_at, context: { revision, source_event_id: evidenceID, check_session: `source-${revision}` } },
        { ...recorded, id: `${evidenceID}-assessment`, kind: "evidence_for", from: evidenceID, to: claimID, rationale: "Exact source line confirmed", assessment: { outcome: "supports", scope: "repo", revision } },
    ];
}

export function checkedAt(records: Record<string, Record<string, unknown>>, revision: string): boolean {
    const sessions = new Set([`source-${revision}`, `recheck-${revision}`]);
    return Object.values(records).some(record => record.kind === "observation" && sessions.has(String((record.context as Record<string, unknown> | undefined)?.check_session)));
}

export function checkout(directory: string, args: string[]): string | undefined {
    const result = spawnSync("git", ["--no-replace-objects", "-C", directory, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
}

export function readBlob(directory: string, revision: string, path: string): string | undefined {
    if (path.split("/").some(part => !part || part === "." || part === "..")) return;
    return checkout(directory, ["cat-file", "blob", `${revision}:${path}`]);
}

