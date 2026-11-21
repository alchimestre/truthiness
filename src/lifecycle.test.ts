import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import truthinessHook from "../.omp/hooks/pre/truthiness.ts";

const zod = { object: () => null, string: () => null } as unknown as Parameters<typeof truthinessHook>[0]["zod"];

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

test("keeps a separate default store per repository and stays silent outside one", async () => {
    const root = mkdtempSync(join(tmpdir(), "truthiness-defaults-"));
    const keys = ["TRUTHINESS_COMMAND", "TRUTHINESS_STORE", "TRUTHINESS_PENDING", "TRUTHINESS_TOKENIZER", "TRUTHINESS_BOOTSTRAP", "XDG_STATE_HOME"];
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        process.env.XDG_STATE_HOME = join(root, "state");
        const repos = ["a", "b"].map(parent => join(root, parent, "app"));
        for (const [position, repo] of repos.entries()) {
            mkdirSync(repo, { recursive: true });
            git(repo, "init", "--quiet");
            writeFileSync(join(repo, "README.md"), `# Guide ${position}\n`);
            git(repo, "add", "README.md");
            git(repo, "commit", "-m", "Guide");
        }
        const handlers = new Map();
        truthinessHook({
            on: (name, handler) => handlers.set(name, handler),
            registerTool: () => {},
            registerCommand: () => {},
            appendEntry: () => {},
            zod,
            logger: { warn: () => {} },
        });
        const session = (cwd: string) => ({ cwd, sessionManager: { getBranch: () => [] } });
        for (const [position, repo] of repos.entries()) {
            const startup = await handlers.get("before_agent_start")({}, session(repo));
            expect(startup.message.content).toContain(`# Guide ${position}`);
            expect(startup.message.content).not.toContain(`# Guide ${1 - position}`);
        }
        expect(readdirSync(join(root, "state", "truthiness"))).toHaveLength(2);
        const outside = join(root, "plain");
        mkdirSync(outside);
        expect(await handlers.get("tool_call")({ toolName: "edit" }, session(outside))).toBeUndefined();
    } finally {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    }
});

async function exerciseLifecycle(repo: string, state: string, store: string) {
    const handlers = new Map();
    const branch: Array<{ type: string; customType: string; data?: unknown }> = [];
    const ctx = { cwd: repo, sessionManager: { getBranch: () => branch, getSessionId: () => "session" } };
    const notices: string[] = [];
    const warnings: string[] = [];
    const command = (args: string) => handlers.get("truthiness")(args, { ...ctx, ui: { notify: (message: string) => notices.push(message) } });
    truthinessHook({
        on: (name, handler) => handlers.set(name, handler),
        registerTool: tool => handlers.set(tool.name, tool.execute),
        registerCommand: (name, command) => handlers.set(name, command.handler),
        appendEntry: (type, data) => { branch.push({ type: "custom", customType: type, data }); },
        zod,
        logger: { warn: (message: string) => { warnings.push(message); } },
    });
    const startup = await handlers.get("before_agent_start")({}, ctx);
    expect(startup.message.content).toContain("README.md: # Parser guide");
    const seeded = readFileSync(store, "utf8");
    branch.push({ type: "custom_message", ...startup.message });
    expect(await handlers.get("before_agent_start")({}, ctx)).toBeUndefined();
    const message = { role: "custom", ...startup.message };
    writeFileSync(join(repo, "new-source"), "uncommitted source");
    expect((await handlers.get("context")({ messages: [message] }, ctx)).messages).toEqual([]);
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toEqual({ additionalContext: expect.stringContaining("may quote") });
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
    const submit = async (jsonl: string) => (await handlers.get("truthiness_draft")("test", { jsonl }, undefined, undefined, ctx)).content[0].text;
    expect(await submit(unsupported)).toBe("0 published, 1 pending automatic or operator review.");
    const staged = readdirSync(state).filter(file => file.endsWith(".jsonl") && file !== "canonical.jsonl");
    expect(staged).toHaveLength(1);
    expect(readFileSync(join(state, staged[0]), "utf8").trim().split("\n").map(line => JSON.parse(line).id).sort()).toEqual(["assessment-1", "claim-1", "observation-1"]);
    expect(readFileSync(store, "utf8")).toBe(seeded);
    expect(warnings).toEqual([]);
    const verified = batch("def handler(request):");
    expect(await submit(verified)).toBe("1 published, 0 pending automatic or operator review.");
    expect(readFileSync(store, "utf8")).toContain('"id":"claim-1"');
    expect(readdirSync(state).filter(file => file.endsWith(".jsonl"))).toHaveLength(2);
    const edit = (path: string) => handlers.get("tool_call")({ toolName: "edit", input: { path } }, ctx);
    expect(await edit("source.py")).toEqual({ additionalContext: expect.stringContaining("notes quote source.py") });
    expect(await edit(join(repo, "unquoted.py"))).toBeUndefined();
    expect(warnings).toEqual([]);
    await expectRecheckAcrossCommits(repo, store);

    await command("off");
    expect(await handlers.get("before_agent_start")({}, ctx)).toBeUndefined();
    expect((await handlers.get("context")({ messages: [message] }, ctx)).messages).toEqual([]);
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toBeUndefined();
    const refused = await handlers.get("truthiness_draft")("test", { jsonl: verified }, undefined, undefined, ctx);
    expect(refused.content[0].text).toContain("off");
    expect(readdirSync(state).filter(file => file.endsWith(".jsonl"))).toHaveLength(2);

    await command("of");
    expect(notices.at(-1)).toContain("Unknown argument");
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toBeUndefined();
    await command("on");
    expect(await handlers.get("tool_call")({ toolName: "edit" }, ctx)).toEqual({ additionalContext: expect.stringContaining("may quote") });
    appendFileSync(store, "not json\n");
    expect(await edit("source.py")).toEqual({ additionalContext: expect.stringContaining("may quote") });
    expect(warnings).toEqual(["Truthiness could not read note anchors; warned on this edit."]);
}

async function expectRecheckAcrossCommits(repo: string, store: string) {
    const startupIndex = () => {
        Bun.spawnSync([executable, "bootstrap", store], { cwd: repo });
        const revision = git(repo, "rev-parse", "HEAD");
        return Bun.spawnSync([executable, "index", store, "", revision, process.env.TRUTHINESS_TOKENIZER!], { cwd: repo }).stdout.toString();
    };
    writeFileSync(join(repo, "LATER.md"), "# Added after the first bootstrap\n");
    git(repo, "add", "LATER.md");
    git(repo, "commit", "-m", "Unrelated");
    const afterUnrelated = startupIndex();
    expect(afterUnrelated).toContain('"id":"claim-1"');
    expect(afterUnrelated.split("Added after the first bootstrap")).toHaveLength(2);
    expect(startupIndex()).toBe(afterUnrelated);
    writeFileSync(join(repo, "source.py"), "def renamed(request):\n    return request\n");
    git(repo, "add", "source.py");
    git(repo, "commit", "-m", "Rename");
    expect(startupIndex()).not.toContain('"id":"claim-1"');
}
