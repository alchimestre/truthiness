import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import truthinessHook from "../.omp/hooks/pre/truthiness.ts";

const executable = fileURLToPath(new URL("./cli.ts", import.meta.url));

function git(cwd: string, ...args: string[]) {
    const output = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], { cwd });
    if (output.exitCode !== 0) throw new Error(output.stderr.toString());
    return output.stdout.toString().trim();
}

test("stages drafts separately and publishes only the explicitly reviewed bytes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "truthiness-repo-"));
    const state = mkdtempSync(join(tmpdir(), "truthiness-state-"));
    const store = join(state, "canonical.jsonl");
    const tokenizer = join(state, "tokenizer");
    const environment = {
        TRUTHINESS_COMMAND: executable,
        TRUTHINESS_STORE: store,
        TRUTHINESS_TOKENIZER: tokenizer,
        TRUTHINESS_PENDING: state,
    };
    const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    try {
        git(repo, "init", "--quiet");
        const snapshot = git(repo, "commit-tree", git(repo, "write-tree"), "-m", "Fixture");
        git(repo, "update-ref", "HEAD", snapshot);
        writeFileSync(store, "");
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
    const command = (args: string) => handlers.get("truthiness")(args, { ...ctx, ui: { notify: (message: string) => notices.push(message) } });
    truthinessHook({
        on: (name, handler) => handlers.set(name, handler),
        registerTool: tool => handlers.set(tool.name, tool.execute),
        registerCommand: (name, command) => handlers.set(name, command.handler),
        appendEntry: (type, data) => { branch.push({ type: "custom", customType: type, data }); },
        zod: builder,
        logger: { warn: (message: string) => { throw new Error(message); } },
    } as Parameters<typeof truthinessHook>[0]);
    const startup = await handlers.get("before_agent_start")({}, ctx);
    expect(startup.message.content.length).toBeGreaterThan(0);
    branch.push({ type: "custom_message", ...startup.message });
    expect(await handlers.get("before_agent_start")({}, ctx)).toBeUndefined();
    const message = { role: "custom", ...startup.message };
    writeFileSync(join(repo, "new-source"), "uncommitted source");
    expect((await handlers.get("context")({ messages: [message] }, ctx)).messages).toEqual([]);
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toEqual({ additionalContext: expect.stringContaining("verify the source") });
    const draft = JSON.stringify({ id: "observation-1", kind: "observation", recorded_at: "2026-01-01T00:00:00Z", recorded_by: "fixture", content: "check output", source_ref: "fixture", captured_at: "2026-01-01T00:00:00Z", context: {} }) + "\n";
    await handlers.get("truthiness_draft")("test", { jsonl: draft, early: false }, undefined, undefined, ctx);
    expect(readdirSync(state).filter(file => file.endsWith(".jsonl"))).toEqual(["canonical.jsonl"]);
    await handlers.get("session_shutdown")({}, ctx);
    const staged = readdirSync(state).filter(file => file.endsWith(".jsonl") && file !== "canonical.jsonl");
    expect(staged).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(state, staged[0]), "utf8"))).toEqual(JSON.parse(draft));
    expect(readFileSync(store, "utf8")).toBe("");
    const reviewed = readFileSync(join(state, staged[0]), "utf8");
    const digest = createHash("sha256").update(reviewed).digest("hex");
    const changed = reviewed.replace("check output", "other output");
    const publish = (jsonl: string) => handlers.get("truthiness_publish")("test", { jsonl, digest }, undefined, undefined, ctx);
    expect((await publish(changed)).isError).toBe(true);
    expect(readFileSync(store, "utf8")).toBe("");
    expect((await publish(reviewed)).isError).toBe(false);
    expect(readFileSync(store, "utf8")).toBe(reviewed);

    await command("off");
    expect(await handlers.get("before_agent_start")({}, ctx)).toBeUndefined();
    expect((await handlers.get("context")({ messages: [message] }, ctx)).messages).toEqual([]);
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toBeUndefined();
    const refused = await handlers.get("truthiness_draft")("test", { jsonl: draft, early: true }, undefined, undefined, ctx);
    expect(refused.content[0].text).toContain("off");
    expect(readdirSync(state).filter(file => file.endsWith(".jsonl"))).toHaveLength(2);

    await command("of");
    expect(notices.at(-1)).toContain("Unknown argument");
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toBeUndefined();
    await command("on");
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toEqual({ additionalContext: expect.stringContaining("verify the source") });
}
