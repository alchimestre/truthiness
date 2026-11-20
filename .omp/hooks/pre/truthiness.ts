import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const messageType = "truthiness-index";
const modeEntry = "truthiness-mode";
const warning = "Project memory may not apply to this edit. Withhold affected claims and verify the source; this does not block the edit.";

function command(program: string, args: string[], cwd: string, input?: string) {
    const result = spawnSync(program, args, { cwd, input, encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return undefined;
    return result.stdout;
}

function snapshot(cwd: string, store: string) {
    const state = command("git", ["status", "--porcelain", "--untracked-files=all"], cwd);
    if (state !== "") return undefined;
    const head = command("git", ["rev-parse", "HEAD"], cwd)?.trim();
    if (!head) return undefined;
    try {
        const digest = createHash("sha256").update(readFileSync(resolve(cwd, store))).digest("hex");
        return { head, digest };
    } catch {
        return undefined;
    }
}

export default function truthinessHook(pi: HookAPI): void {
    const program = process.env.TRUTHINESS_COMMAND;
    const store = process.env.TRUTHINESS_STORE;
    const tokenizer = process.env.TRUTHINESS_TOKENIZER;
    const pending = process.env.TRUTHINESS_PENDING;
    if (!program || !store) return;
    const drafts = new Map<string, string>();
    let enabled = true;
    registerPublication(pi, program, store);

    const restoreMode = (ctx: { sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> } }) => {
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "custom" || entry.customType !== modeEntry) continue;
            const data = entry.data as { enabled?: unknown } | undefined;
            if (typeof data?.enabled === "boolean") enabled = data.enabled;
        }
    };

    const setMode = (next: boolean, ctx: { ui: { notify(message: string, level?: string): void } }) => {
        enabled = next;
        pi.appendEntry(modeEntry, { enabled });
        ctx.ui.notify(`Truthiness ${enabled ? "enabled" : "disabled"} for this session.`, "info");
    };

    const modeByArgument: Record<string, boolean> = { on: true, off: false };

    pi.registerCommand("truthiness", {
        description: "Toggle project memory for this session (on/off/status)",
        handler: async (args, ctx) => {
            restoreMode(ctx);
            const argument = args.trim().toLowerCase();
            if (argument === "") {
                setMode(!enabled, ctx);
                return;
            }
            if (argument === "status") {
                ctx.ui.notify(`Truthiness is ${enabled ? "enabled" : "disabled"}.`, "info");
                return;
            }
            if (!Object.hasOwn(modeByArgument, argument)) {
                ctx.ui.notify(`Unknown argument "${argument}"; use on, off or status.`, "warning");
                return;
            }
            setMode(modeByArgument[argument], ctx);
        },
    });

    for (const event of ["session_start", "session_tree", "session_compact"] as const) {
        pi.on(event, async (_event, ctx) => restoreMode(ctx));
    }

    pi.registerTool({
        name: "truthiness_draft",
        label: "Memory draft",
        description: "Hold one complete proposal batch in session memory, or stage an urgent correction for independent review. Never publishes.",
        parameters: pi.zod.object({ jsonl: pi.zod.string(), early: pi.zod.boolean() }),
        async execute(_id, { jsonl, early }, _signal, _onUpdate, ctx) {
            if (!enabled) return { content: [{ type: "text", text: "Truthiness is off for this session; nothing was held or staged." }], details: {} };
            const staged = early && stage(ctx.cwd, jsonl);
            if (!early) drafts.set(ctx.sessionManager.getSessionId(), jsonl);
            return {
                content: [{ type: "text", text: early ? (staged ? "Pending independent review." : "Could not stage; proposal not published.") : "Draft held until closeout." }],
                details: {},
                isError: early && !staged,
            };
        },
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        if (!enabled || !tokenizer) return;
        const current = snapshot(ctx.cwd, store);
        if (!current) return;
        const key = `${current.head}:${current.digest}`;
        if (ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === messageType && entry.details === key)) return;
        const index = command(program, ["index", store, "", current.head, tokenizer], ctx.cwd);
        if (index === undefined) {
            pi.logger.warn("Truthiness could not generate the startup index; verify against source.");
            return;
        }
        const after = snapshot(ctx.cwd, store);
        if (after?.head !== current.head || after.digest !== current.digest) return;
        return { message: { customType: messageType, content: index, display: false, details: key } };
    });

    pi.on("context", async (event, ctx) => {
        if (!enabled) return { messages: event.messages.filter(message => message.role !== "custom" || message.customType !== messageType) };
        const current = tokenizer ? snapshot(ctx.cwd, store) : undefined;
        const key = current ? `${current.head}:${current.digest}` : undefined;
        let seen = false;
        const messages = event.messages.filter(message => {
            if (message.role !== "custom" || message.customType !== messageType) return true;
            if (!key || message.details !== key || seen) return false;
            seen = true;
            return true;
        });
        return { messages };
    });

    pi.on("tool_call", async (event) => {
        if (!enabled) return;
        if (event.toolName === "edit" || event.toolName === "write") return { additionalContext: warning };
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        const id = ctx.sessionManager.getSessionId();
        const draft = drafts.get(id);
        if (draft === undefined) return;
        if (enabled && !stage(ctx.cwd, draft)) pi.logger.warn("Project memory closeout did not stage the draft.");
        drafts.delete(id);
    });

    function stage(cwd: string, draft: string): boolean {
        if (!pending) return false;
        const path = resolve(cwd, pending, `${randomUUID()}.jsonl`);
        return command(program, ["stage", path], cwd, draft) !== undefined;
    }
}

function registerPublication(pi: HookAPI, program: string, store: string): void {
    pi.registerTool({
        name: "truthiness_publish",
        label: "Publish reviewed memory",
        description: "Publish an independently reviewed empirical batch to shared memory. Supply the exact reviewed JSONL and its SHA-256 digest. Do not publish from the proposing session. Axioms require separate human authorization.",
        parameters: pi.zod.object({ jsonl: pi.zod.string(), digest: pi.zod.string() }),
        async execute(_id, { jsonl, digest }, _signal, _onUpdate, ctx) {
            const published = command(program, ["publish", store, digest], ctx.cwd, jsonl) !== undefined;
            return {
                content: [{ type: "text", text: published ? "Published reviewed batch." : "Could not confirm publication; check the canonical store before retrying." }],
                details: {},
                isError: !published,
            };
        },
    });
}
