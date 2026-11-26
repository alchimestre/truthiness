#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anchoredPathsOf, anchoredWarning, cleanSourceRevision, command, defaultProgram, defaultTokenizer, memoryPaths, noteFormatHelp, repositoryRelative, runWorker, stageAndReview, unknownTargetWarning } from "./agent.ts";
import { bootstrapAllowed, claudeHeadless, recallContext } from "./session.ts";

type HookInput = { cwd?: unknown; tool_input?: unknown; prompt?: unknown };

const program = process.env.TRUTHINESS_COMMAND || defaultProgram;
const tokenizer = process.env.TRUTHINESS_TOKENIZER || defaultTokenizer;
const self = fileURLToPath(import.meta.url);
const patchTarget = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const warn = (text: string) => console.error(text);

const [event] = process.argv.slice(2);
const input = await new Response(Bun.stdin.stream()).text();
if (event === "session-start") await sessionStart(parseHookInput(input));
else if (event === "post-edit") await postEdit(parseHookInput(input));
else if (event === "prompt-submit") await promptSubmit(parseHookInput(input));
else if (event === "draft") await draft(input);
else {
    console.error("usage: hook.ts session-start | post-edit | prompt-submit | draft");
    process.exit(2);
}

function parseHookInput(text: string): { cwd: string; toolInput: unknown; prompt: string } {
    const parsed = JSON.parse(text) as HookInput;
    return {
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : process.cwd(),
        toolInput: parsed.tool_input,
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
    };
}

async function sessionStart({ cwd }: { cwd: string }) {
    const { store } = memoryPaths(cwd);
    const head = cleanSourceRevision(cwd);
    if (!store || !head) return;
    if (bootstrapAllowed(claudeHeadless())) {
        await runWorker(program, ["bootstrap", store], { cwd, timeout: 15_000 }).catch(() => warn("Truthiness could not bootstrap project memory."));
    }
    if (existsSync(resolve(cwd, store))) {
        const index = command(program, ["index", store, "", head, tokenizer], cwd);
        if (index === undefined) return warn("Truthiness could not generate the startup index.");
        process.stdout.write(index);
    }
    console.log(`To propose notes, pipe store records as JSONL, secrets removed, to \`${self} draft\`. Supported notes publish; the rest stay pending. ${noteFormatHelp}`);
}

async function postEdit({ cwd, toolInput }: { cwd: string; toolInput: unknown }) {
    const { root, store } = memoryPaths(cwd);
    if (!store || !existsSync(resolve(cwd, store))) return;
    const edited = root ? repositoryRelative(editTargets(toolInput), cwd, root) : [];
    const anchored = edited.length ? await anchoredPathsOf(program, resolve(cwd, store), cwd) : undefined;
    const quoted = anchored ? edited.filter(path => anchored.has(path)) : [];
    const context = anchored ? (quoted.length ? anchoredWarning(quoted) : undefined) : unknownTargetWarning;
    if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
}

async function promptSubmit({ cwd, prompt }: { cwd: string; prompt: string }) {
    const { store } = memoryPaths(cwd);
    const head = cleanSourceRevision(cwd);
    if (!store || !head || !existsSync(resolve(cwd, store))) return;
    const context = recallContext(program, store, head, tokenizer, cwd, prompt);
    if (context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
}

// Claude Code edit tools name the file; Codex apply_patch sends the patch text as `command`.
function editTargets(toolInput: unknown): string[] {
    if (!toolInput || typeof toolInput !== "object") return [];
    const fields = toolInput as Record<string, unknown>;
    const named = [fields.file_path, fields.notebook_path, fields.path].filter((value): value is string => typeof value === "string");
    const patch = typeof fields.command === "string" ? [...fields.command.matchAll(patchTarget)].map(match => match[1].trim()) : [];
    return [...named, ...patch];
}

async function draft(jsonl: string) {
    const cwd = process.cwd();
    const { store, pending } = memoryPaths(cwd);
    if (!store || !pending) {
        console.error("No project memory is configured for this directory.");
        process.exit(1);
    }
    console.log(await stageAndReview(program, cwd, store, pending, jsonl, warn));
}
