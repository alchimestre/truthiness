import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { promisify } from "node:util";

const messageType = "truthiness-index";
const modeEntry = "truthiness-mode";
const unknownTargetWarning = "Truthiness notes may quote the file this edit changes. After the edit, re-read that file before repeating or acting on its notes. The edit is not blocked.";
const anchorCache = new Map<string, { stamp: string; paths: Set<string> }>();
const runWorker = promisify(execFile);

function command(program: string, args: string[], cwd: string, input?: string) {
    const result = spawnSync(program, args, { cwd, input, encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return undefined;
    return result.stdout;
}

function anchoredWarning(paths: string[]) {
    return `Truthiness notes quote ${paths.join(", ")}. After this edit, re-read the file before repeating or acting on those notes. The edit is not blocked.`;
}

function editedPaths(input: ToolCallEvent["input"] | undefined, cwd: string, root: string): string[] {
    if (!input || typeof input !== "object") return [];
    const path = "path" in input ? input.path : undefined;
    const paths = "paths" in input ? input.paths : undefined;
    const candidates = [path, ...(Array.isArray(paths) ? paths : [])];
    const realRoot = realPath(root);
    const targets = candidates.filter((value): value is string => typeof value === "string");
    return targets.map(value => relative(realRoot, realPath(resolve(cwd, value))));
}

// A file being created has no realpath yet, so its parent directory is resolved instead.
function realPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return dirname(path) === path ? path : join(realPath(dirname(path)), basename(path));
    }
}

function cleanHead(cwd: string) {
    if (command("git", ["status", "--porcelain", "--untracked-files=all"], cwd) !== "") return undefined;
    return command("git", ["rev-parse", "HEAD"], cwd)?.trim();
}

function snapshot(cwd: string, store: string, head = cleanHead(cwd)) {
    if (!head) return undefined;
    try {
        const digest = createHash("sha256").update(readFileSync(resolve(cwd, store))).digest("hex");
        return { head, digest };
    } catch {
        return undefined;
    }
}

const repositoryRoots = new Map<string, string | undefined>();

function memoryPaths(cwd: string) {
    if (!repositoryRoots.has(cwd)) repositoryRoots.set(cwd, command("git", ["rev-parse", "--show-toplevel"], cwd)?.trim());
    const root = repositoryRoots.get(cwd);
    const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    const repository = root && join(stateHome, "truthiness", `${basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`);
    return {
        root,
        store: process.env.TRUTHINESS_STORE || (repository && join(repository, "canonical.jsonl")),
        pending: process.env.TRUTHINESS_PENDING || (repository && join(repository, "pending")),
    };
}

type Entry = { type: string; customType?: string; data?: unknown; details?: unknown };
type Session = { cwd: string; sessionManager: { getBranch(): Entry[] } };
type Message = { role: string; customType?: string; details?: unknown };
type HookAPI = Pick<ExtensionAPI, "appendEntry" | "on" | "registerCommand" | "registerTool" | "zod"> & {
    logger: Pick<ExtensionAPI["logger"], "warn">;
};
type Hook = { pi: HookAPI; program: string; tokenizer: string; enabled: boolean };

export default function truthinessHook(pi: HookAPI): void {
    const hook: Hook = {
        pi,
        program: process.env.TRUTHINESS_COMMAND || fileURLToPath(new URL("../../../src/cli.ts", import.meta.url)),
        tokenizer: process.env.TRUTHINESS_TOKENIZER || fileURLToPath(new URL("../../../scripts/truthiness-tokenizer.sh", import.meta.url)),
        enabled: true,
    };
    registerModeCommand(hook);
    pi.on("session_start", async (_event, ctx) => restoreMode(hook, ctx));
    pi.on("session_tree", async (_event, ctx) => restoreMode(hook, ctx));
    pi.on("session_compact", async (_event, ctx) => restoreMode(hook, ctx));
    registerDraftTool(hook);
    pi.on("before_agent_start", async (_event, ctx) => startupIndex(hook, ctx));
    pi.on("context", async (event, ctx) => ({ messages: currentIndexOnly(hook, event.messages, ctx.cwd) }));
    pi.on("tool_call", async (event, ctx) => editWarning(hook, event, ctx.cwd));
}

function restoreMode(hook: Hook, ctx: Session) {
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== modeEntry) continue;
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") hook.enabled = data.enabled;
    }
}

const modeByArgument: Record<string, boolean> = { on: true, off: false };

function registerModeCommand(hook: Hook) {
    const setMode = (next: boolean, ctx: { ui: { notify(message: string, level?: string): void } }) => {
        hook.enabled = next;
        hook.pi.appendEntry(modeEntry, { enabled: next });
        ctx.ui.notify(`Truthiness ${next ? "enabled" : "disabled"} for this session.`, "info");
    };
    hook.pi.registerCommand("truthiness", {
        description: "Toggle project memory for this session (on/off/status)",
        handler: async (args, ctx) => {
            restoreMode(hook, ctx);
            const argument = args.trim().toLowerCase();
            if (argument === "") return setMode(!hook.enabled, ctx);
            if (argument === "status") return ctx.ui.notify(`Truthiness is ${hook.enabled ? "enabled" : "disabled"}.`, "info");
            if (!Object.hasOwn(modeByArgument, argument)) return ctx.ui.notify(`Unknown argument "${argument}"; use on, off or status.`, "warning");
            setMode(modeByArgument[argument], ctx);
        },
    });
}

function registerDraftTool(hook: Hook) {
    hook.pi.registerTool({
        name: "truthiness_draft",
        label: "Memory draft",
        description: "Submit new notes as store records in JSONL, one per line, with secrets removed. Each note is checked against committed source now: supported notes publish, the rest stay pending.",
        parameters: hook.pi.zod.object({ jsonl: hook.pi.zod.string() }),
        async execute(_id, { jsonl }, _signal, _onUpdate, ctx) {
            if (!hook.enabled) return { content: [{ type: "text", text: "Truthiness is off for this session; nothing was staged." }], details: {} };
            const { store, pending } = memoryPaths(ctx.cwd);
            if (!store || !pending) return { content: [{ type: "text", text: "No project memory is configured for this directory." }], details: {}, isError: true };
            const text = await stageAndReview(hook, ctx.cwd, store, pending, jsonl);
            return { content: [{ type: "text", text }], details: {} };
        },
    });
}

async function startupIndex(hook: Hook, ctx: Session) {
    if (!hook.enabled) return;
    const { store } = memoryPaths(ctx.cwd);
    const head = cleanHead(ctx.cwd);
    if (!store || !head) return;
    if (process.env.TRUTHINESS_BOOTSTRAP !== "off") {
        const bootstrap = runWorker(hook.program, ["bootstrap", store], { cwd: ctx.cwd, timeout: 15_000 });
        await bootstrap.catch(() => hook.pi.logger.warn("Truthiness could not bootstrap project memory."));
    }
    const current = snapshot(ctx.cwd, store, head);
    if (!current) return;
    const key = `${current.head}:${current.digest}`;
    if (ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === messageType && entry.details === key)) return;
    const index = command(hook.program, ["index", store, "", current.head, hook.tokenizer], ctx.cwd);
    if (index === undefined) {
        hook.pi.logger.warn("Truthiness could not generate the startup index.");
        return;
    }
    const after = snapshot(ctx.cwd, store);
    if (after?.head !== current.head || after.digest !== current.digest) return;
    return { message: { customType: messageType, content: index, display: false, details: key } };
}

function currentIndexOnly<T extends Message>(hook: Hook, messages: T[], cwd: string): T[] {
    const isIndex = (message: T) => message.role === "custom" && message.customType === messageType;
    if (!hook.enabled) return messages.filter(message => !isIndex(message));
    const { store } = memoryPaths(cwd);
    const current = store && existsSync(resolve(cwd, store)) ? snapshot(cwd, store) : undefined;
    const key = current ? `${current.head}:${current.digest}` : undefined;
    let seen = false;
    return messages.filter(message => {
        if (!isIndex(message)) return true;
        if (!key || message.details !== key || seen) return false;
        seen = true;
        return true;
    });
}

async function editWarning(hook: Hook, event: ToolCallEvent, cwd: string) {
    if (!hook.enabled || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const { root, store } = memoryPaths(cwd);
    if (!store || !existsSync(resolve(cwd, store))) return;
    const edited = root ? editedPaths(event.input, cwd, root) : [];
    if (edited.length === 0) return { additionalContext: unknownTargetWarning };
    const anchored = await anchoredPathsOf(hook.program, resolve(cwd, store), cwd);
    if (!anchored) {
        hook.pi.logger.warn("Truthiness could not read note anchors; warned on this edit.");
        return { additionalContext: unknownTargetWarning };
    }
    const quoted = edited.filter(path => anchored.has(path));
    if (quoted.length) return { additionalContext: anchoredWarning(quoted) };
}

async function anchoredPathsOf(program: string, store: string, cwd: string): Promise<Set<string> | undefined> {
    const { mtimeMs, size } = statSync(store);
    const stamp = `${mtimeMs}:${size}`;
    const cached = anchorCache.get(store);
    if (cached?.stamp === stamp) return cached.paths;
    try {
        const { stdout } = await runWorker(program, ["anchors", store], { cwd, timeout: 5000 });
        const parsed = JSON.parse(stdout) as { paths?: unknown };
        if (!Array.isArray(parsed.paths) || !parsed.paths.every(path => typeof path === "string")) return undefined;
        const paths = new Set(parsed.paths as string[]);
        anchorCache.set(store, { stamp, paths });
        return paths;
    } catch {
        return undefined;
    }
}

async function stageAndReview(hook: Hook, cwd: string, store: string, pendingDirectory: string, draft: string): Promise<string> {
    const path = resolve(cwd, pendingDirectory, `${randomUUID()}.jsonl`);
    if (command(hook.program, ["stage", path], cwd, draft) === undefined) {
        const text = "Could not confirm staging; nothing was sent for automatic review.";
        hook.pi.logger.warn(text);
        return text;
    }
    try {
        const { stdout } = await runWorker(hook.program, ["review-pending", store, path], { cwd, timeout: 40_000 });
        const result = JSON.parse(stdout) as { published: number; pending: number };
        if (!Number.isSafeInteger(result.published) || result.published < 0 || !Number.isSafeInteger(result.pending) || result.pending < 0) {
            throw new Error("invalid review outcome");
        }
        if (result.pending === 0 && result.published > 0) {
            await unlink(path).catch(() => hook.pi.logger.warn("Truthiness published the batch but could not remove its staged copy."));
        }
        return `${result.published} published, ${result.pending} pending automatic or operator review.`;
    } catch {
        const text = "Could not confirm automatic review; the staged batch was retained.";
        hook.pi.logger.warn(text);
        return text;
    }
}
