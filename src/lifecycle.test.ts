import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import truthinessHook from "../.omp/hooks/pre/truthiness.ts";

const executable = fileURLToPath(new URL("./cli.ts", import.meta.url));

function git(cwd: string, ...args: string[]) {
    const options = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];
    const output = Bun.spawnSync(["git", ...options, ...args], { cwd });
    if (output.exitCode !== 0) throw new Error(output.stderr.toString());
    return output.stdout.toString().trim();
}

test("bootstraps startup memory and reviews staged drafts without a second session", async () => {
    const repo = mkdtempSync(join(tmpdir(), "truthiness-repo-"));
    const state = mkdtempSync(join(tmpdir(), "truthiness-state-"));
    const store = join(state, "canonical.jsonl");
    const tokenizer = join(state, "tokenizer");
    const environment = {
        TRUTHINESS_COMMAND: executable,
        TRUTHINESS_STORE: store,
        TRUTHINESS_TOKENIZER: tokenizer,
        TRUTHINESS_PENDING: state,
        TRUTHINESS_BOOTSTRAP: "on",
        TRUTHINESS_REVIEWER: "",
    };
    const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    try {
        git(repo, "init", "--quiet");
        writeFileSync(join(repo, "README.md"), "# Parser guide\n");
        git(repo, "add", "README.md");
        git(repo, "commit", "-m", "Guide");
        writeFileSync(tokenizer, "#!/bin/sh\nwc -c\n", { mode: 0o700 });
        Object.assign(process.env, environment);
        await exerciseLifecycle(repo, state, store);
    } finally {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(repo, { recursive: true, force: true });
        rmSync(state, { recursive: true, force: true });
    }
});

async function exerciseLifecycle(repo: string, state: string, store: string) {
    const handlers = new Map();
    const branch = [];
    const ctx = { cwd: repo, sessionManager: { getBranch: () => branch, getSessionId: () => "session" } };
    const builder = { object: () => null, string: () => null, boolean: () => null };
    const notices: string[] = [];
    const warnings: string[] = [];
    const command = (args: string) => handlers.get("truthiness")(args, { ...ctx, ui: { notify: (message: string) => notices.push(message) } });
    truthinessHook({
        on: (name, handler) => handlers.set(name, handler),
        registerTool: tool => handlers.set(tool.name, tool.execute),
        registerCommand: (name, command) => handlers.set(name, command.handler),
        appendEntry: (type, data) => { branch.push({ type: "custom", customType: type, data }); },
        zod: builder,
        logger: { warn: (message: string) => { warnings.push(message); } },
    } as Parameters<typeof truthinessHook>[0]);
    const startup = await handlers.get("before_agent_start")({}, ctx);
    expect(startup.message.content).toContain("README.md: # Parser guide");
    const seeded = readFileSync(store, "utf8");
    branch.push({ type: "custom_message", ...startup.message });
    expect(await handlers.get("before_agent_start")({}, ctx)).toBeUndefined();
    const message = { role: "custom", ...startup.message };
    writeFileSync(join(repo, "new-source"), "uncommitted source");
    expect((await handlers.get("context")({ messages: [message] }, ctx)).messages).toEqual([]);
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toEqual({ additionalContext: expect.stringContaining("verify the source") });
    writeFileSync(join(repo, "source.py"), "def handler(request):\n    return request\n");
    git(repo, "add", "source.py");
    git(repo, "commit", "-m", "Source");
    const revision = git(repo, "rev-parse", "HEAD");
    const batch = (excerpt: string) => [
        { id: "claim-1", kind: "claim", recorded_at: "2026-01-01T00:00:00Z", recorded_by: "fixture", text: "source.py: def handler(request):", scope: "repo", anchors: [{ path: "source.py" }], check: null },
        { id: "observation-1", kind: "observation", recorded_at: "2026-01-01T00:00:00Z", recorded_by: "fixture", content: excerpt, source_ref: `${revision}:source.py`, captured_at: "2026-01-01T00:00:00Z", context: { revision, source_event_id: "observation-1", check_session: "fixture" } },
        { id: "assessment-1", kind: "evidence_for", recorded_at: "2026-01-01T00:00:00Z", recorded_by: "fixture", from: "observation-1", to: "claim-1", rationale: "Exact source line confirmed", assessment: { outcome: "supports", scope: "repo", revision } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n";
    const unsupported = batch("not a source line");
    await handlers.get("truthiness_draft")("test", { jsonl: unsupported, early: false }, undefined, undefined, ctx);
    expect(readdirSync(state).filter(file => file.endsWith(".jsonl"))).toEqual(["canonical.jsonl"]);
    await handlers.get("session_shutdown")({}, ctx);
    const staged = readdirSync(state).filter(file => file.endsWith(".jsonl") && file !== "canonical.jsonl");
    expect(staged).toHaveLength(1);
    expect(readFileSync(join(state, staged[0]), "utf8").trim().split("\n").map(line => JSON.parse(line).id).sort()).toEqual(["assessment-1", "claim-1", "observation-1"]);
    expect(readFileSync(store, "utf8")).toBe(seeded);
    expect(warnings).toEqual([]);
    const verified = batch("def handler(request):");
    const submit = (jsonl: string, early: boolean) => handlers.get("truthiness_draft")("test", { jsonl, early }, undefined, undefined, ctx);
    await submit(verified, false);
    expect(readFileSync(store, "utf8")).toBe(seeded);
    await handlers.get("session_shutdown")({}, ctx);
    expect(readFileSync(store, "utf8")).toContain('"id":"claim-1"');
    expect(readdirSync(state).filter(file => file.endsWith(".jsonl"))).toHaveLength(2);

    await command("off");
    expect(await handlers.get("before_agent_start")({}, ctx)).toBeUndefined();
    expect((await handlers.get("context")({ messages: [message] }, ctx)).messages).toEqual([]);
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toBeUndefined();
    const refused = await handlers.get("truthiness_draft")("test", { jsonl: verified, early: true }, undefined, undefined, ctx);
    expect(refused.content[0].text).toContain("off");
    expect(readdirSync(state).filter(file => file.endsWith(".jsonl"))).toHaveLength(2);

    await command("of");
    expect(notices.at(-1)).toContain("Unknown argument");
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toBeUndefined();
    await command("on");
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toEqual({ additionalContext: expect.stringContaining("verify the source") });
}
