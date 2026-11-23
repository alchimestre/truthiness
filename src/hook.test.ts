import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./hook.ts", import.meta.url));
const source = "export function parseConfig(text: string) { return text; }";
let root: string;
let repo: string;

function git(...args: string[]) {
    const options = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];
    const output = Bun.spawnSync(["git", ...options, ...args], { cwd: repo });
    if (output.exitCode !== 0) throw new Error(output.stderr.toString());
    return output.stdout.toString().trim();
}

function runHook(event: string, input: string) {
    const environment: Record<string, string | undefined> = { ...process.env, TRUTHINESS_REVIEWER: "" };
    for (const key of ["TRUTHINESS_STORE", "TRUTHINESS_PENDING", "TRUTHINESS_COMMAND", "TRUTHINESS_TOKENIZER", "TRUTHINESS_BOOTSTRAP"]) delete environment[key];
    const output = Bun.spawnSync([hook, event], { cwd: repo, stdin: Buffer.from(input), env: environment });
    const stderr = output.stderr.toString();
    expect(output.exitCode, `${event}: ${stderr}`).toBe(0);
    expect(stderr).toBe("");
    return output.stdout.toString();
}

function editContext(toolInput: object): string | undefined {
    const stdout = runHook("post-edit", JSON.stringify({ cwd: repo, tool_input: toolInput }));
    return stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : undefined;
}

function quoteNote(id: string, path: string, line: string) {
    const revision = git("rev-parse", "HEAD");
    const stamp = { recorded_at: "2026-11-22T18:00:00Z", recorded_by: "agent" };
    const claim = { id, kind: "claim", text: `${path}: ${line}`, scope: "repo", anchors: [{ path }], check: null, ...stamp };
    const observation = { id: `${id}-source`, kind: "observation", content: line, source_ref: `${revision}:${path}`, captured_at: stamp.recorded_at, context: { revision, source_event_id: `${id}-source`, check_session: "agent" }, ...stamp };
    const evidence = { id: `${id}-evidence`, kind: "evidence_for", from: observation.id, to: id, rationale: "Quoted line", assessment: { outcome: "supports", scope: "repo", revision }, ...stamp };
    return [claim, observation, evidence].map(record => JSON.stringify(record)).join("\n") + "\n";
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "truthiness-hook-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git("init", "--quiet");
    writeFileSync(join(repo, "config.ts"), `${source}\n`);
    writeFileSync(join(repo, "notes.txt"), "unrelated\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Fixture");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("session start injects the index and draft instructions only on a clean tree", () => {
    const startup = runHook("session-start", JSON.stringify({ cwd: repo, source: "startup" }));
    expect(startup).toContain(`config.ts: ${source}`);
    expect(startup).toContain(`${hook} draft`);
    expect(startup).toContain("Writing notes");

    appendFileSync(join(repo, "notes.txt"), "uncommitted\n");
    expect(runHook("session-start", JSON.stringify({ cwd: repo }))).toBe("");
});

test("edits warn only for quoted files, from Claude Code paths and Codex patches", () => {
    runHook("session-start", JSON.stringify({ cwd: repo }));
    expect(editContext({ file_path: join(repo, "config.ts"), old_string: "a", new_string: "b" })).toContain("quote config.ts");
    expect(editContext({ command: "*** Begin Patch\n*** Update File: config.ts\n@@\n-a\n+b\n*** End Patch\n" })).toContain("quote config.ts");
    expect(editContext({ file_path: join(repo, "notes.txt"), content: "x" })).toBeUndefined();
    expect(editContext({})).toContain("may quote the file");
});

test("a drafted quote note publishes and reaches the next session", () => {
    writeFileSync(join(repo, "limits.ts"), "export const RETRY_LIMIT = 3;\n");
    git("add", "limits.ts");
    git("commit", "--quiet", "-m", "Limit");
    const line = "export const RETRY_LIMIT = 3;";
    expect(runHook("draft", quoteNote("retry-limit", "limits.ts", line))).toContain("1 published, 0 pending");
    expect(runHook("session-start", JSON.stringify({ cwd: repo }))).toContain(`limits.ts: ${line}`);
});
