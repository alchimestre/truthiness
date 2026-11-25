import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
    }, `/*${"\"\\".repeat(4100)}\n${excerpt}\n*/\n`);
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

test("a rewritten body hides a behavioral note whose quoted line survives, not a bare quote or a moved block", () => {
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
        expect(recheckedAt(cwd, reviewer, rewritten)).toEqual({ quote: true, behavior: false });
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

function recheckedAt(cwd: string, reviewer: string, revision: string) {
    const run = Bun.spawnSync(["bun", cli, "bootstrap", "canonical.jsonl"], { cwd, env: { ...process.env, TRUTHINESS_REVIEWER: reviewer } });
    expect(run.exitCode).toBe(0);
    const store = readFileSync(join(cwd, "canonical.rechecks.jsonl"), "utf8");
    const rechecked = (id: string) => store.includes(`"id":"${id}-recheck-${revision.slice(0, 12)}-0"`);
    return { quote: rechecked("quote"), behavior: rechecked("behavior") };
}

function reviewPending(cwd: string, path: string, reviewer = "") {
    const result = Bun.spawnSync(["bun", cli, "review-pending", "canonical.jsonl", path], { cwd, env: { ...process.env, TRUTHINESS_REVIEWER: reviewer } });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
}
