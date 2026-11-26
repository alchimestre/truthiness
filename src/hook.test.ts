import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

function runHook(event: string, input: string, extra: Record<string, string> = {}) {
    const environment: Record<string, string | undefined> = { ...process.env, TRUTHINESS_REVIEWER: "" };
    for (const key of ["TRUTHINESS_STORE", "TRUTHINESS_PENDING", "TRUTHINESS_COMMAND", "TRUTHINESS_TOKENIZER", "TRUTHINESS_BOOTSTRAP", "CLAUDE_CODE_ENTRYPOINT"]) delete environment[key];
    Object.assign(environment, extra);
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

function quoteNote(id: string, path: string, line: string, text = `${path}: ${line}`) {
    const revision = git("rev-parse", "HEAD");
    const stamp = { recorded_at: "2026-11-22T18:00:00Z", recorded_by: "agent" };
    const claim = { id, kind: "claim", text, scope: "repo", anchors: [{ path }], check: null, ...stamp };
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

test("a prompt gets matching behavioral claims as context, not bare quotes; an unrelated prompt gets none", () => {
    const line = "export const RETRY_LIMIT = 3;";
    writeFileSync(join(repo, "limits.ts"), `${line}\n`);
    git("add", "limits.ts");
    git("commit", "--quiet", "-m", "Limit");
    const reviewer = join(root, "reviewer");
    writeFileSync(reviewer, "#!/usr/bin/env bun\nconst { candidates } = await Bun.stdin.json();\nconsole.log(JSON.stringify(candidates.map(candidate => candidate.id)));\n", { mode: 0o700 });
    runHook("draft", quoteNote("retry-line", "limits.ts", line));
    const drafted = runHook("draft", quoteNote("retry-limit", "limits.ts", line, "RETRY_LIMIT allows three retries."), { TRUTHINESS_REVIEWER: reviewer });
    expect(drafted).toContain("Under semantic review in the background");
    waitForStore(`"id":"retry-limit"`);
    const context = JSON.parse(runHook("prompt-submit", JSON.stringify({ cwd: repo, prompt: "How many retries does RETRY_LIMIT allow?" }))).hookSpecificOutput.additionalContext;
    expect(context).toContain("RETRY_LIMIT allows three retries.");
    expect(context).not.toContain(`limits.ts: ${line}`);
    expect(runHook("prompt-submit", JSON.stringify({ cwd: repo, prompt: "Rename the logging helper" }))).toBe("");
});

test("a background rejection is reported once at the next session start", () => {
    const line = "export const RETRY_LIMIT = 3;";
    writeFileSync(join(repo, "limits.ts"), `${line}\n`);
    git("add", "limits.ts");
    git("commit", "--quiet", "-m", "Limit");
    const reviewer = join(root, "reviewer");
    writeFileSync(reviewer, "#!/bin/sh\necho '[]'\n", { mode: 0o700 });
    runHook("draft", quoteNote("retry-limit", "limits.ts", line, "RETRY_LIMIT allows ten retries."), { TRUTHINESS_REVIEWER: reviewer });
    const pending = join(repo, ".git", "truthiness", "pending");
    waitUntil(() => readdirSync(pending).some(name => name.endsWith(".outcome.json") && readFileSync(join(pending, name), "utf8").trim().endsWith("}")), "background outcome");
    const input = JSON.stringify({ cwd: repo });
    expect(runHook("session-start", input)).toContain('Truthiness background review rejected "retry-limit"');
    expect(runHook("session-start", input)).not.toContain("background review");
});

test("a background review that never finished is reported and cleared; one still running is left alone", () => {
    const pending = join(repo, ".git", "truthiness", "pending");
    mkdirSync(pending, { recursive: true });
    const crashed = join(pending, "crashed.jsonl");
    writeFileSync(crashed, `${JSON.stringify({ id: "lost-claim", kind: "claim", text: "x" })}\n`);
    writeFileSync(`${crashed}.outcome.json`, "");
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(`${crashed}.outcome.json`, elevenMinutesAgo, elevenMinutesAgo);
    writeFileSync(join(pending, "running.jsonl.outcome.json"), "");
    const input = JSON.stringify({ cwd: repo });
    expect(runHook("session-start", input)).toContain('Truthiness background review did not finish for "lost-claim"');
    expect(existsSync(`${crashed}.outcome.json`)).toBe(false);
    expect(existsSync(crashed)).toBe(true);
    expect(existsSync(join(pending, "running.jsonl.outcome.json"))).toBe(true);
    expect(runHook("session-start", input)).not.toContain("background review");
});

const backgroundReviewWaitMs = 15_000;
const pollMs = 100;

function waitForStore(text: string) {
    const store = join(repo, ".truthiness", "canonical.jsonl");
    waitUntil(() => existsSync(store) && readFileSync(store, "utf8").includes(text), `store entry ${text}`);
}

function waitUntil(done: () => boolean, label: string) {
    const deadline = Date.now() + backgroundReviewWaitMs;
    while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        Bun.sleepSync(pollMs);
    }
}

test("a headless session start skips bootstrap unless TRUTHINESS_BOOTSTRAP=on", () => {
    const input = JSON.stringify({ cwd: repo });
    const headless = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
    expect(runHook("session-start", input, headless)).not.toContain(`config.ts: ${source}`);
    expect(runHook("session-start", input, { ...headless, TRUTHINESS_BOOTSTRAP: "on" })).toContain(`config.ts: ${source}`);
});
