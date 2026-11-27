import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backgroundReviewNotice, reviewInBackground } from "./agent.ts";
import { readBlobsAt } from "./bootstrap.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const excerpt = "export function parse(value) { return value; }";
const timestamp = "2026-01-01T00:00:00Z";

function fixture(run: (directory: string, revision: string) => void, source = `${excerpt}\n`) {
    const directory = mkdtempSync(join(tmpdir(), "truthiness-review-"));
    try {
        git(directory, "init", "--quiet");
        writeFileSync(join(directory, "parser.js"), source);
        git(directory, "add", "parser.js");
        git(directory, "commit", "-qm", "Parser");
        run(directory, git(directory, "rev-parse", "HEAD"));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function batch(revision: string, id: string, text: string, content = excerpt, sourcePath = "parser.js") {
    const common = { recorded_at: timestamp, recorded_by: "fixture" };
    const observation = `${id}-source`;
    return [
        { ...common, id, kind: "claim", text, scope: "repo", anchors: [{ path: sourcePath }], check: null },
        { ...common, id: observation, kind: "observation", content, source_ref: `${revision}:${sourcePath}`, captured_at: timestamp, context: { revision, source_event_id: observation, check_session: "fixture" } },
        { ...common, id: `${id}-evidence`, kind: "evidence_for", from: observation, to: id, rationale: "Source line", assessment: { outcome: "supports", scope: "repo", revision } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n";
}

function git(cwd: string, ...args: string[]) {
    const options = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];
    const result = Bun.spawnSync(["git", ...options, ...args], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
}

test("automated review does not treat line presence as semantic support", () => {
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        writeFileSync(path, batch(revision, "false", "The parser validates its input.") + batch(revision, "quote", `parser.js: ${excerpt}`));
        expect(reviewPending(cwd, path)).toMatchObject({ published: 1, pending: 1 });
        const store = readFileSync(join(cwd, "canonical.jsonl"), "utf8");
        expect(store).toContain('"id":"quote"');
        expect(store).not.toContain('"id":"false"');
        expect(reviewPending(cwd, path)).toMatchObject({ published: 0, pending: 1 });
        expect(readFileSync(join(cwd, "canonical.jsonl"), "utf8")).toBe(store);
    });
});

test("mixed review reports distinct pending reasons without exposing evidence", () => {
    fixture((cwd, previous) => {
        writeFileSync(join(cwd, "later.txt"), "changed\n");
        git(cwd, "add", "later.txt");
        git(cwd, "commit", "-qm", "New revision");
        const revision = git(cwd, "rev-parse", "HEAD");
        const path = join(cwd, "pending.jsonl");
        const draft = batch(revision, "quote", `parser.js: ${excerpt}`) +
            batch(previous, "stale", `parser.js: ${excerpt}`) +
            batch(revision, "semantic", "The parser returns its argument.");
        writeFileSync(path, draft);
        expect(reviewPending(cwd, path)).toEqual({
            published: 1,
            pending: 2,
            pendingReasons: [
                { id: "stale", reason: "stale_evidence" },
                { id: "semantic", reason: "semantic_review_required" },
            ],
        });
        expect(readFileSync(path, "utf8")).toBe(draft);
        const store = readFileSync(join(cwd, "canonical.jsonl"), "utf8");
        expect(store).toContain('"id":"quote"');
        expect(store).not.toContain('"id":"stale"');
        expect(store).not.toContain('"id":"semantic"');
    });
});

test("replace refs do not move the source revision past a store-only commit", () => {
    fixture((cwd, revision) => {
        writeFileSync(join(cwd, "parser.js"), "export function replaced() {}\n");
        git(cwd, "add", "parser.js");
        const replacement = git(cwd, "commit-tree", git(cwd, "write-tree"), "-p", revision, "-m", "Replacement");
        git(cwd, "reset", "-q", "--hard");
        mkdirSync(join(cwd, ".truthiness"));
        writeFileSync(join(cwd, ".truthiness", "canonical.jsonl"), "");
        git(cwd, "add", ".truthiness");
        git(cwd, "commit", "-qm", "Store");
        git(cwd, "replace", git(cwd, "rev-parse", "HEAD"), replacement);
        const path = join(cwd, "pending.jsonl");
        writeFileSync(path, batch(revision, "quote", `parser.js: ${excerpt}`));
        expect(reviewPending(cwd, path)).toEqual({ published: 1, pending: 0, pendingReasons: [] });
    });
});

test("a generic reviewer cannot approve IDs outside grounded candidates", () => {
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(path, batch(revision, "supported", "`parse` returns its argument.") +
            batch(revision, "fabricated", "`parse` returns null.", "export function parse(value) { return null; }"));
        writeFileSync(reviewer, "#!/bin/sh\nprintf '%s\\n' '[\"supported\",\"fabricated\"]'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 0, pending: 2 });
        writeFileSync(reviewer, `#!/usr/bin/env bun
const { rubric, candidates } = await Bun.stdin.json();
if (!rubric.includes("Abstain") || candidates.length !== 1 || candidates[0].excerpts[0].text !== ${JSON.stringify(excerpt)}) process.exit(2);
console.log(JSON.stringify(candidates.map(candidate => candidate.id)));
`);
        expect(reviewPending(cwd, path, reviewer)).toEqual({
            published: 1, pending: 1, pendingReasons: [{ id: "fabricated", reason: "source_mismatch" }],
        });
        expect(readFileSync(join(cwd, "canonical.jsonl"), "utf8")).not.toContain('"id":"fabricated"');
    });
});

test("a reviewer verdict after prose counts only as a trailing array block", () => {
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(path, batch(revision, "supported", "`parse` returns its argument."));
        writeFileSync(reviewer, "#!/bin/sh\nprintf '%s\\n' 'The claim [holds] for parse.' '' '[\"supported\"]'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toEqual({ published: 1, pending: 0, pendingReasons: [] });
        writeFileSync(path, batch(revision, "trailing", "`parse` returns its argument."));
        writeFileSync(reviewer, "#!/bin/sh\nprintf '%s\\n' '[\"trailing\"]' 'On reflection, abstain.'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 0, pendingReasons: [{ id: "trailing", reason: "semantic_review_required" }] });
        writeFileSync(path, batch(revision, "inline", "`parse` returns its argument."));
        writeFileSync(reviewer, "#!/bin/sh\nprintf '%s\\n' 'Approved: [\"inline\"]'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 0, pendingReasons: [{ id: "inline", reason: "semantic_review_required" }] });
        writeFileSync(path, batch(revision, "pretty", "`parse` returns its argument."));
        writeFileSync(reviewer, "#!/bin/sh\nprintf '%s\\n' 'Holds.' '[' '  \"pretty\"' ']'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toEqual({ published: 1, pending: 0, pendingReasons: [] });
        writeFileSync(path, batch(revision, "typeset", "`parse` returns its argument."));
        writeFileSync(reviewer, "#!/bin/sh\nprintf '%s\\n' 'Holds.' '[\u201Ctypeset\u201D]'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toEqual({ published: 1, pending: 0, pendingReasons: [] });
    });
});

test("a claim about a source file larger than 16 KiB reaches the reviewer", () => {
    const largeSource = `${excerpt}\n${"// padding\n".repeat(3000)}`;
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(path, batch(revision, "large", "`parse` returns its argument."));
        writeFileSync(reviewer, "#!/bin/sh\necho '[\"large\"]'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toEqual({ published: 1, pending: 0, pendingReasons: [] });
    }, largeSource);
});

test("a claim about a source file over the request cap is reviewed from windows around its excerpt", () => {
    const largeSource = `${"// padding\n".repeat(4000)}${excerpt}\n${"// padding\n".repeat(4000)}`;
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(path, batch(revision, "windowed", "`parse` returns its argument."));
        writeFileSync(reviewer, `#!/usr/bin/env bun
const input = await Bun.stdin.text();
const [source] = JSON.parse(input).sources;
const shown = source.windows?.some(window => window.text.includes("return value"));
console.log(JSON.stringify(input.length <= 64 * 1024 && shown && !("text" in source) ? ["windowed"] : []));
`, { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toEqual({ published: 1, pending: 0, pendingReasons: [] });
    }, largeSource);
});

test("an oversized source is reviewed when its secret lies outside the windows, and withheld when inside", () => {
    const secret = 'const api_key = "test-placeholder-only";';
    const padding = "// padding\n".repeat(4000);
    for (const [label, source, published] of [
        ["outside", `${secret}\n${padding}${excerpt}\n${padding}`, 1],
        ["inside", `${padding}${secret}\n${excerpt}\n${padding}`, 0],
        ["straddling", `${padding}-----BEGIN ENCRYPTED PRIVATE KEY-----\n${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n".repeat(80)}-----END ENCRYPTED PRIVATE KEY-----\n${excerpt}\n${padding}`, 0],
    ] as const) {
        fixture((cwd, revision) => {
            const path = join(cwd, "pending.jsonl");
            const reviewer = join(cwd, "reviewer");
            writeFileSync(path, batch(revision, label, "`parse` returns its argument."));
            writeFileSync(reviewer, `#!/bin/sh\necho '["${label}"]'\n`, { mode: 0o700 });
            expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published });
        }, source);
    }
});

test("semantic review sees committed delimiters omitted from a proposed excerpt", () => {
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(path, batch(revision, "runtime", "`parse` returns its argument at runtime."));
        writeFileSync(join(cwd, "parser.js"), `${excerpt}\n`);
        writeFileSync(reviewer, `#!/usr/bin/env bun
const { candidates, sources = [] } = await Bun.stdin.json();
const parser = sources.find(source => source.path === "parser.js");
const commented = parser?.text === ${JSON.stringify(`/*\n${excerpt}\n*/\n`)};
console.log(JSON.stringify(commented ? [] : candidates.map(candidate => candidate.id)));
`, { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toEqual({
            published: 0, pending: 1, pendingReasons: [{ id: "runtime", reason: "semantic_review_rejected" }],
        });
    }, `/*\n${excerpt}\n*/\n`);
});

test("oversized committed context does not block other claims", () => {
    fixture((cwd) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(join(cwd, "helper.js"), `${excerpt}\n`);
        git(cwd, "add", "helper.js");
        git(cwd, "commit", "-qm", "Helper");
        const current = git(cwd, "rev-parse", "HEAD");
        writeFileSync(path, batch(current, "runtime", "`parse` returns its argument in parser.js.") +
            batch(current, "quote", `parser.js: ${excerpt}`) +
            batch(current, "helper", "`parse` returns its argument in helper.js.", excerpt, "helper.js"));
        writeFileSync(reviewer, `#!/usr/bin/env bun
const { candidates } = await Bun.stdin.json();
console.log(JSON.stringify(candidates.map(candidate => candidate.id)));
`, { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 2, pending: 1 });
    }, `/*${"\"\\".repeat(17_000)}\n${excerpt}\n*/\n`);
});

test("semantic review does not send detectable secrets outside the proposed excerpt", () => {
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(path, batch(revision, "runtime", "`parse` returns its argument at runtime."));
        writeFileSync(reviewer, "#!/bin/sh\nprintf '%s\\n' '[\"runtime\"]'\n", { mode: 0o700 });
        expect(reviewPending(cwd, path, reviewer)).toEqual({
            published: 0, pending: 1, pendingReasons: [{ id: "runtime", reason: "semantic_review_required" }],
        });
    }, `const api_key = "test-placeholder-only";\n${excerpt}\n`);
});

test("bootstrap uses ignored notes as leads, not as evidence", () => {
    fixture((cwd) => {
        const count = 200;
        for (let index = 0; index < count; index++) writeFileSync(join(cwd, `a-${index}.js`), `function helper${index}() {}\n`);
        writeFileSync(join(cwd, "z-important.md"), "# Verified guide\nThe parser accepts strings.\n");
        writeFileSync(join(cwd, ".gitignore"), ".scratch/\n");
        mkdirSync(join(cwd, ".scratch"));
        writeFileSync(join(cwd, ".scratch", "notes.md"), "# False guide\n`z-important.md`: The parser accepts strings.\nz-important.md: The parser accepts anything.\n");
        git(cwd, "add", ".");
        git(cwd, "commit", "-qm", "Guides");
        const subdirectory = join(cwd, "nested");
        mkdirSync(subdirectory);
        const first = Bun.spawnSync(["bun", cli, "bootstrap", "../canonical.jsonl"], { cwd: subdirectory });
        expect(first.stderr.toString()).toBe("");
        expect(first.exitCode).toBe(0);
        const seeded = readFileSync(join(cwd, "canonical.jsonl"), "utf8");
        expect(seeded).toContain("z-important.md: # Verified guide");
        expect(seeded).toContain("z-important.md: The parser accepts strings.");
        expect(seeded).not.toContain("The parser accepts anything.");
        expect(seeded).not.toContain("False guide");
        writeFileSync(join(cwd, "later.txt"), "changed\n");
        git(cwd, "add", "later.txt");
        git(cwd, "commit", "-qm", "New revision");
        const second = Bun.spawnSync(["bun", cli, "bootstrap", "canonical.jsonl"], { cwd });
        expect(second.exitCode).toBe(0);
        expect(readFileSync(join(cwd, "canonical.jsonl"), "utf8")).toBe(seeded);
        expect(readFileSync(join(cwd, "canonical.rechecks.jsonl"), "utf8")).toContain("Source excerpt still present");
    });
});

test("batched source reads return each committed file and skip missing paths and directories", () => {
    fixture((cwd, revision) => {
        mkdirSync(join(cwd, "lib"));
        writeFileSync(join(cwd, "lib", "empty.js"), "");
        git(cwd, "add", ".");
        git(cwd, "commit", "-qm", "Add lib");
        const head = git(cwd, "rev-parse", "HEAD");
        const sources = readBlobsAt(cwd, head, ["missing.js", "parser.js", "lib", "lib/empty.js", "../parser.js"]);
        expect([...sources]).toEqual([["parser.js", `${excerpt}\n`], ["lib/empty.js", ""]]);
        expect(readBlobsAt(cwd, revision, ["lib/empty.js"]).size).toBe(0);
    });
});

test("bootstrap skips paths with the truthiness attribute unset", () => {
    fixture((cwd) => {
        mkdirSync(join(cwd, "bench"));
        writeFileSync(join(cwd, "bench", "fixture.md"), "# Planted fixture\nThe parser rejects strings.\n");
        writeFileSync(join(cwd, "guide.md"), "# Real guide\nThe parser accepts strings.\n");
        writeFileSync(join(cwd, ".gitattributes"), "bench/** -truthiness\n");
        git(cwd, "add", ".");
        git(cwd, "commit", "-qm", "Fixture");
        const run = Bun.spawnSync(["bun", cli, "bootstrap", "canonical.jsonl"], { cwd });
        expect(run.exitCode).toBe(0);
        const seeded = readFileSync(join(cwd, "canonical.jsonl"), "utf8");
        expect(seeded).toContain("guide.md: # Real guide");
        expect(seeded).not.toContain("bench/fixture.md");
    });
});

test("staged source evidence at a past revision does not publish at HEAD", () => {
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        writeFileSync(path, batch(revision, "quote", `parser.js: ${excerpt}`));
        writeFileSync(join(cwd, "later.txt"), "changed\n");
        git(cwd, "add", "later.txt");
        git(cwd, "commit", "-qm", "New revision");
        expect(reviewPending(cwd, path)).toEqual({
            published: 0, pending: 1, pendingReasons: [{ id: "quote", reason: "stale_evidence" }],
        });
    });
});

test("a rewritten body sends a behavioral note back to the reviewer, not a bare quote or a moved block", () => {
    const opener = "export function parse(value) {";
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(reviewer, "#!/usr/bin/env bun\nconst { candidates } = await Bun.stdin.json();\nconsole.log(JSON.stringify(candidates.map(candidate => candidate.id)));\n", { mode: 0o700 });
        writeFileSync(path, batch(revision, "quote", `parser.js: ${opener}`, opener) + batch(revision, "behavior", "`parse` returns its argument unchanged.", opener));
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 2 });
        const moved = commitParser(cwd, `export function other() {\n    return 1;\n}\n\n${opener}\n    return value;\n}\n`);
        expect(recheckedAt(cwd, reviewer, moved)).toEqual({ quote: true, behavior: true });
        const rewritten = commitParser(cwd, `${opener}\n    return value.trim();\n}\n`);
        const rejectAll = join(cwd, "reject-all");
        writeFileSync(rejectAll, "#!/bin/sh\necho '[]'\n", { mode: 0o700 });
        expect(recheckedAt(cwd, rejectAll, rewritten)).toEqual({ quote: true, behavior: false });
    }, `${opener}\n    return value;\n}\n`);
});

test("claims whose sources overflow one reviewer request are reviewed in a second call", () => {
    const filler = `// ${"x".repeat(100)}\n`.repeat(400);
    fixture((cwd, revision) => {
        const calls = join(cwd, "calls");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(reviewer, `#!/usr/bin/env bun\nconst { candidates } = await Bun.stdin.json();\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, "call\\n");\nconsole.log(JSON.stringify(candidates.map(candidate => candidate.id)));\n`, { mode: 0o700 });
        writeFileSync(join(cwd, "other.js"), `export function other(value) { return value; }\n${filler}`);
        git(cwd, "add", ".");
        git(cwd, "commit", "-qm", "Two large files");
        const head = git(cwd, "rev-parse", "HEAD");
        const path = join(cwd, "pending.jsonl");
        writeFileSync(path, batch(head, "first", "`parse` returns its argument.") + batch(head, "second", "`other` returns its argument.", "export function other(value) { return value; }", "other.js"));
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 2 });
        expect(readFileSync(calls, "utf8")).toBe("call\ncall\n");
    }, `${excerpt}\n${filler}`);
});

test("a recheck skips the reviewer only when the store shows the code around the quote unchanged", () => {
    const opener = "export function parse(value) {";
    const leaf = "    return value;";
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const approveAll = join(cwd, "approve-all");
        const rejectAll = join(cwd, "reject-all");
        writeFileSync(approveAll, "#!/usr/bin/env bun\nconst { candidates } = await Bun.stdin.json();\nconsole.log(JSON.stringify(candidates.map(candidate => candidate.id)));\n", { mode: 0o700 });
        writeFileSync(rejectAll, "#!/bin/sh\necho '[]'\n", { mode: 0o700 });
        writeFileSync(path, batch(revision, "behavior", "`parse` returns its argument unchanged.", opener) + batch(revision, "leaf", "`parse` hands back its argument.", leaf));
        expect(reviewPending(cwd, path, approveAll)).toMatchObject({ published: 2 });
        writeFileSync(join(cwd, "other.js"), "export const other = 1;\n");
        git(cwd, "add", "other.js");
        git(cwd, "commit", "-qm", "Unrelated file");
        const elsewhere = git(cwd, "rev-parse", "HEAD");
        expect(recheckedAt(cwd, rejectAll, elsewhere, ["behavior", "leaf"])).toEqual({ behavior: true, leaf: true });
        const near = commitParser(cwd, `${opener}\n${leaf}\n}\n// note\n`);
        expect(recheckedAt(cwd, rejectAll, near, ["behavior", "leaf"])).toEqual({ behavior: true, leaf: false });
    }, `export function parse(value) {\n    return value;\n}\n`);
});

test("a recheck re-anchors a reworded quote and sends it to the reviewer; a bare quote is not re-anchored", () => {
    const opener = "export function parse(value) {";
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const seen = join(cwd, "seen");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(reviewer, `#!/usr/bin/env bun\nconst { candidates } = await Bun.stdin.json();\nconst ids = candidates.map(candidate => candidate.id);\nrequire("node:fs").appendFileSync(${JSON.stringify(seen)}, ids.join(",") + "\\n");\nconsole.log(JSON.stringify(ids));\n`, { mode: 0o700 });
        writeFileSync(path, batch(revision, "behavior", "`parse` returns its argument unchanged.", "    return value;") + batch(revision, "quote", `parser.js: ${opener}`, opener));
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 2 });
        writeFileSync(seen, "");
        const reworded = commitParser(cwd, "export function parseInput(value) {\n    return value; // as given\n}\n");
        expect(recheckedAt(cwd, reviewer, reworded)).toEqual({ quote: false, behavior: true });
        expect(readFileSync(seen, "utf8")).toBe("behavior\n");
        expect(readFileSync(join(cwd, "canonical.rechecks.jsonl"), "utf8")).toContain('"content":"return value; // as given"');
    }, `${opener}\n    return value;\n}\n`);
});

test("a draft shaped like a recheck of a published claim still needs the reviewer", () => {
    const opener = "export function parse(value) {";
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const rejectAll = join(cwd, "reject-all");
        writeFileSync(rejectAll, "#!/bin/sh\necho '[]'\n", { mode: 0o700 });
        writeFileSync(path, batch(revision, "behavior", "`parse` returns its argument unchanged.", opener));
        expect(reviewPending(cwd, path, rejectAll)).toMatchObject({ published: 0, pendingReasons: [{ id: "behavior", reason: "semantic_review_rejected" }] });
        writeFileSync(path, batch(revision, "seed", "`parse` returns its argument.", opener));
        Bun.spawnSync(["bun", cli, "pending-approve", "canonical.jsonl", "pending.jsonl", "seed"], { cwd });
        const stored = readFileSync(join(cwd, "canonical.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
        const block = stored.find(record => record.id === "seed-source").context.block_sha256;
        const forged = batch(revision, "forged", "`parse` validates its argument.", opener).split("\n").filter(Boolean).map(line => {
            const record = { ...JSON.parse(line), recorded_by: "truthiness-recheck" };
            return JSON.stringify(record.kind === "observation" ? { ...record, context: { ...record.context, block_sha256: block } } : record);
        });
        writeFileSync(path, `${forged.join("\n")}\n`);
        expect(reviewPending(cwd, path, rejectAll)).toMatchObject({ published: 0, pendingReasons: [{ id: "forged", reason: "semantic_review_rejected" }] });
    }, `${opener}\n    return value;\n}\n`);
});

test("a one-line quote must be unique in its file; a multi-line excerpt may repeat a line", () => {
    const source = "function a() {\n    return 1;\n}\nfunction b() {\n    return 1;\n}\n";
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        writeFileSync(path,
            batch(revision, "dup", "parser.js: return 1;", "    return 1;") +
            batch(revision, "unique", "parser.js: function a() {", "function a() {") +
            batch(revision, "block", "The parser returns one.", "function a() {\n    return 1;\n}"));
        expect(reviewPending(cwd, path)).toEqual({
            published: 1,
            pending: 2,
            pendingReasons: [
                { id: "dup", reason: "ambiguous_quote" },
                { id: "block", reason: "semantic_review_required" },
            ],
        });
    }, source);
});

function commitParser(cwd: string, source: string) {
    writeFileSync(join(cwd, "parser.js"), source);
    git(cwd, "commit", "-qam", "Edit parser");
    return git(cwd, "rev-parse", "HEAD");
}

function recheckedAt(cwd: string, reviewer: string, revision: string, ids = ["quote", "behavior"]) {
    const env = { ...process.env, TRUTHINESS_REVIEWER: "" };
    expect(Bun.spawnSync(["bun", cli, "bootstrap", "canonical.jsonl"], { cwd, env }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", cli, "recheck-review", "canonical.jsonl"], { cwd, env: { ...env, TRUTHINESS_REVIEWER: reviewer } }).exitCode).toBe(0);
    const store = readFileSync(join(cwd, "canonical.rechecks.jsonl"), "utf8");
    return Object.fromEntries(ids.map(id => [id, store.includes(`"id":"${id}-recheck-${revision.slice(0, 12)}-0"`)]));
}

test("bootstrap returns before reviewer rechecks, which finish in a background process", () => {
    fixture((cwd, revision) => {
        const path = join(cwd, "pending.jsonl");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(reviewer, "#!/usr/bin/env bun\nconst { candidates } = await Bun.stdin.json();\nconsole.log(JSON.stringify(candidates.map(candidate => candidate.id)));\n", { mode: 0o700 });
        writeFileSync(path, batch(revision, "behavior", "`parse` returns its argument unchanged.", "    return value;"));
        expect(reviewPending(cwd, path, reviewer)).toMatchObject({ published: 1 });
        const reworded = commitParser(cwd, "export function parse(value) {\n    return value; // as given\n}\n");
        expect(Bun.spawnSync(["bun", cli, "bootstrap", "canonical.jsonl"], { cwd, env: { ...process.env, TRUTHINESS_REVIEWER: reviewer } }).exitCode).toBe(0);
        const rechecks = join(cwd, "canonical.rechecks.jsonl");
        const deadline = Date.now() + backgroundRecheckWaitMs;
        // The detached recheck process exposes no handle or event, so the test can only poll its output file.
        while (!(existsSync(rechecks) && readFileSync(rechecks, "utf8").includes(`behavior-recheck-${reworded.slice(0, 12)}`)) && Date.now() < deadline) Bun.sleepSync(pollMs);
        expect(readFileSync(rechecks, "utf8")).toContain(`behavior-recheck-${reworded.slice(0, 12)}`);
    }, "export function parse(value) {\n    return value;\n}\n");
});

test("bootstrap reviews a draft once the code it quotes is committed", () => {
    fixture((cwd, revision) => {
        const pending = join(cwd, "pending");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(reviewer, "#!/usr/bin/env bun\nconst { candidates } = await Bun.stdin.json();\nconsole.log(JSON.stringify(candidates.map(candidate => candidate.id)));\n", { mode: 0o700 });
        mkdirSync(pending);
        const draft = join(pending, "draft.jsonl");
        writeFileSync(draft, batch(revision, "trim", "`parse` trims its argument.", "    return value.trim();"));
        expect(reviewPending(cwd, draft)).toMatchObject({ published: 0, pending: 1 });
        commitParser(cwd, "export function parse(value) {\n    return value.trim();\n}\n");
        expect(Bun.spawnSync(["bun", cli, "bootstrap", "canonical.jsonl", pending], { cwd, env: { ...process.env, TRUTHINESS_REVIEWER: reviewer } }).exitCode).toBe(0);
        const store = join(cwd, "canonical.jsonl");
        const deadline = Date.now() + backgroundRecheckWaitMs;
        // The detached review process exposes no handle or event, so the test can only poll its output file.
        while (!(existsSync(store) && readFileSync(store, "utf8").includes('"id":"trim"')) && Date.now() < deadline) Bun.sleepSync(pollMs);
        expect(readFileSync(store, "utf8")).toContain('"id":"trim"');
    });
});

test("a failing background reviewer is named in the next session notice", () => {
    fixture((cwd, revision) => {
        const pending = join(cwd, "pending");
        const reviewer = join(cwd, "reviewer");
        writeFileSync(reviewer, "#!/bin/sh\necho 'REVIEW_COMMAND is not set' >&2\nexit 1\n", { mode: 0o700 });
        mkdirSync(pending);
        const draft = join(pending, "draft.jsonl");
        writeFileSync(draft, batch(revision, "trim", "`parse` returns its argument.", excerpt));
        process.env.TRUTHINESS_REVIEWER = reviewer;
        try {
            reviewInBackground(["bun", cli], cwd, "canonical.jsonl", draft);
        } finally {
            delete process.env.TRUTHINESS_REVIEWER;
        }
        const deadline = Date.now() + backgroundRecheckWaitMs;
        while (!readFileSync(`${draft}.outcome.json`, "utf8") && Date.now() < deadline) Bun.sleepSync(pollMs);
        const notice = backgroundReviewNotice(cwd, pending);
        expect(notice).toContain("The reviewer command failed: reviewer");
        expect(notice).toContain("REVIEW_COMMAND is not set");
    });
});

const backgroundRecheckWaitMs = 10_000;
const pollMs = 100;

function reviewPending(cwd: string, path: string, reviewer = "") {
    const result = Bun.spawnSync(["bun", cli, "review-pending", "canonical.jsonl", path], { cwd, env: { ...process.env, TRUTHINESS_REVIEWER: reviewer } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
}

test("pending approval publishes a semantic claim once its quote matches source", () => {
    fixture((cwd, revision) => {
        writeFileSync(join(cwd, "pending.jsonl"), batch(revision, "parse", "Parser returns its input unchanged"));
        const approve = Bun.spawnSync(["bun", cli, "pending-approve", "canonical.jsonl", "pending.jsonl", "parse"], { cwd });
        expect(approve.stderr.toString()).toBe("");
        expect(approve.exitCode).toBe(0);
        expect(readFileSync(join(cwd, "canonical.jsonl"), "utf8")).toContain('"id":"parse"');
    });
});

test("human pending approval does not publish a claim whose quote no longer matches source", () => {
    fixture((cwd, revision) => {
        writeFileSync(join(cwd, "pending.jsonl"), batch(revision, "parse", "Parser returns its input unchanged", "export function gone() {}"));
        const approve = Bun.spawnSync(["bun", cli, "pending-approve", "canonical.jsonl", "pending.jsonl", "parse"], { cwd });
        expect(approve.exitCode).toBe(1);
        expect(() => readFileSync(join(cwd, "canonical.jsonl"), "utf8")).toThrow();
    });
});

test("pending decline removes one claim's records from the pending file", () => {
    fixture((cwd, revision) => {
        writeFileSync(join(cwd, "pending.jsonl"), batch(revision, "parse", "Parser returns its input unchanged") + batch(revision, "keep", "Parser keeps its input"));
        const decline = Bun.spawnSync(["bun", cli, "pending-decline", "canonical.jsonl", "pending.jsonl", "parse"], { cwd });
        expect(decline.exitCode).toBe(0);
        const remaining = readFileSync(join(cwd, "pending.jsonl"), "utf8");
        expect(remaining).toContain('"id":"keep"');
        expect(remaining).not.toContain('"id":"parse"');
    });
});

test("pending shows one claim at a time with a count of the rest", () => {
    fixture((cwd, revision) => {
        writeFileSync(join(cwd, "pending.jsonl"), batch(revision, "parse", "Parser returns its input unchanged") + batch(revision, "keep", "Parser keeps its input"));
        const shown = Bun.spawnSync(["bun", cli, "pending", "canonical.jsonl", "pending.jsonl"], { cwd });
        expect(shown.exitCode).toBe(0);
        expect(shown.stdout.toString()).toContain("semantic_review_required");
        expect(shown.stdout.toString()).toContain("1 more pending");
    });
});
