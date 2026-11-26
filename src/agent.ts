import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PendingReason } from "./review.ts";
import { storeDirectory } from "./store.ts";

export const unknownTargetWarning = "Truthiness notes may quote the file this edit changes. After the edit, re-read that file before repeating or acting on its notes. The edit is not blocked.";
export const defaultProgram = fileURLToPath(new URL("./cli.ts", import.meta.url));
export const tokenizerArgument = (tokenizer: string | undefined) => tokenizer ? [tokenizer] : [];
export const noteFormatHelp = `Note format: section "Writing notes" in ${fileURLToPath(new URL("../README.md", import.meta.url))}.`;
export const runWorker = promisify(execFile);

export function command(program: string, args: string[], cwd: string, input?: string) {
    const result = spawnSync(program, args, { cwd, input, encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return undefined;
    return result.stdout;
}

export function anchoredWarning(paths: string[]) {
    return `Truthiness notes quote ${paths.join(", ")}. After this edit, re-read the file before repeating or acting on those notes. The edit is not blocked.`;
}

export function cleanSourceRevision(cwd: string) {
    const status = command("git", ["--no-replace-objects", "status", "--porcelain", "--untracked-files=all", "--", ":(top)", `:(top,exclude)${storeDirectory}`], cwd);
    if (status !== "") return undefined;
    return sourceRevision(cwd);
}

// Evidence is keyed to this, not HEAD: a commit touching only the store must not make every note stale.
export function sourceRevision(cwd: string) {
    const lastSourceChange = command("git", ["--no-replace-objects", "log", "-1", "--format=%H", "HEAD", "--", ":(top)", `:(top,exclude)${storeDirectory}`], cwd)?.trim();
    return lastSourceChange || command("git", ["rev-parse", "--verify", "HEAD^{commit}"], cwd)?.trim();
}

const repositories = new Map<string, { root: string; gitDirectory: string } | undefined>();

export function memoryPaths(cwd: string) {
    if (!repositories.has(cwd)) {
        const [root, gitDirectory] = command("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], cwd)?.trim().split("\n") ?? [];
        repositories.set(cwd, root && gitDirectory ? { root, gitDirectory } : undefined);
    }
    const repository = repositories.get(cwd);
    return {
        root: repository?.root,
        store: process.env.TRUTHINESS_STORE || (repository && join(repository.root, storeDirectory, "canonical.jsonl")),
        pending: process.env.TRUTHINESS_PENDING || (repository && join(repository.gitDirectory, "truthiness", "pending")),
    };
}

export function repositoryRelative(targets: string[], cwd: string, root: string): string[] {
    const realRoot = realPath(root);
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

const anchorCache = new Map<string, { stamp: string; paths: Set<string> }>();

export async function anchoredPathsOf(program: string, store: string, cwd: string): Promise<Set<string> | undefined> {
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

export async function stageAndReview(program: string, cwd: string, store: string, pendingDirectory: string, draft: string, warn: (text: string) => void): Promise<string> {
    const path = resolve(cwd, pendingDirectory, `${randomUUID()}.jsonl`);
    if (command(program, ["stage", path], cwd, draft) === undefined) {
        const text = "Could not confirm staging; nothing was sent for automatic review.";
        warn(text);
        return text;
    }
    try {
        const maxBuffer = Buffer.byteLength(draft) + 1024 * 1024;
        const codeOnly = { ...process.env, TRUTHINESS_REVIEWER: "" };
        const { stdout } = await runWorker(program, ["review-pending", store, path], { cwd, timeout: 40_000, maxBuffer, env: codeOnly });
        const result = JSON.parse(stdout) as { published: number; pending: number; pendingReasons: unknown };
        if (!Number.isSafeInteger(result.published) || result.published < 0 || !Number.isSafeInteger(result.pending) || result.pending < 0) {
            throw new Error("invalid review outcome");
        }
        const background = Boolean(process.env.TRUTHINESS_REVIEWER) && needsSemanticReview(result.pendingReasons);
        if (background) reviewInBackground(program, cwd, store, path);
        const reasons = formatPendingReasons(result.pendingReasons, result.pending, background);
        const summary = `${result.published} published, ${result.pending} pending automatic or operator review.`;
        return [summary, ...reasons].join("\n");
    } catch {
        const text = "Could not confirm automatic review; the staged batch was retained.";
        warn(text);
        return text;
    }
}

const outcomeSuffix = ".outcome.json";

function reviewInBackground(program: string, cwd: string, store: string, path: string) {
    const outcome = openSync(`${path}${outcomeSuffix}`, "w");
    spawn(program, ["review-pending", store, path], { cwd, detached: true, stdio: ["ignore", outcome, "ignore"] }).unref();
    closeSync(outcome);
}

// Longer than one reviewer call (30 s timeout) plus startup, with wide margin.
const crashedReviewAgeMs = 10 * 60 * 1000;

export function backgroundReviewNotice(cwd: string, pendingDirectory: string): string | undefined {
    const directory = resolve(cwd, pendingDirectory);
    if (!existsSync(directory)) return undefined;
    const rejected: string[] = [];
    const unresolved: string[] = [];
    const crashed: string[] = [];
    for (const name of readdirSync(directory).filter(entry => entry.endsWith(outcomeSuffix))) {
        const path = join(directory, name);
        const reasons = finishedOutcome(path);
        if (reasons) {
            for (const { id, reason } of reasons) {
                if (reason === "semantic_review_rejected") rejected.push(JSON.stringify(id));
                if (reason === "semantic_review_required") unresolved.push(JSON.stringify(id));
            }
        } else if (Date.now() - statSync(path).mtimeMs > crashedReviewAgeMs) {
            crashed.push(...stagedClaimIDs(path.slice(0, -outcomeSuffix.length)));
        } else continue;
        unlinkSync(path);
    }
    const lines = [];
    if (rejected.length) lines.push(`Truthiness background review rejected ${listed(rejected)}. Revise the claim or its evidence and draft it again.`);
    if (unresolved.length) lines.push(`Truthiness background review returned no verdict for ${listed(unresolved)}; they stay pending for operator review.`);
    if (crashed.length) lines.push(`Truthiness background review did not finish for ${listed(crashed)}; they stay pending for operator review.`);
    return lines.length ? lines.join("\n") : undefined;
}

function finishedOutcome(path: string): { id: unknown; reason: unknown }[] | undefined {
    try {
        const { pendingReasons } = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(pendingReasons) ? pendingReasons : undefined;
    } catch {
        return undefined;
    }
}

function stagedClaimIDs(batchPath: string): string[] {
    if (!existsSync(batchPath)) return [];
    return readFileSync(batchPath, "utf8").split("\n").flatMap(line => {
        try {
            const record = JSON.parse(line);
            return record?.kind === "claim" ? [JSON.stringify(record.id)] : [];
        } catch {
            return [];
        }
    });
}

function listed(labels: string[]): string {
    const hidden = labels.length - maxListedIds;
    return `${labels.slice(0, maxListedIds).join(", ")}${hidden > 0 ? ` and ${hidden} more` : ""}`;
}

const pendingActions = {
    invalid_batch: "Fix the evidence links in the draft",
    missing_evidence: "Attach supporting evidence",
    invalid_evidence: "Fix the evidence metadata to match the claim and its anchors",
    stale_evidence: "Refresh the evidence at the current source revision",
    source_mismatch: "Refresh the excerpt from committed source",
    ambiguous_quote: "Quote a line unique in its file, or quote several consecutive lines",
    missing_anchor_coverage: "Attach supporting evidence for every anchor",
    semantic_review_required: "Request semantic or operator review",
    semantic_review_rejected: "Revise the claim or its evidence; the semantic reviewer did not approve it",
} satisfies Record<PendingReason, string>;
const maxListedIds = 10;

const backgroundReviewAction = "Under semantic review in the background; approved claims reach the store and the next startup index";

function needsSemanticReview(reasons: unknown): boolean {
    return Array.isArray(reasons) && reasons.some(entry => entry?.reason === "semantic_review_required");
}

function formatPendingReasons(reasons: unknown, count: number, background: boolean): string[] {
    if (!Array.isArray(reasons) || reasons.length !== count) throw new Error("invalid pending reasons");
    const labelsByReason = new Map<PendingReason, string[]>();
    for (const entry of reasons as ({ id?: unknown; reason?: unknown } | null)[]) {
        if (!entry || (entry.id !== null && typeof entry.id !== "string") ||
            typeof entry.reason !== "string" || !Object.hasOwn(pendingActions, entry.reason)) {
            throw new Error("invalid pending reason");
        }
        const reason = entry.reason as PendingReason;
        if (!labelsByReason.has(reason)) labelsByReason.set(reason, []);
        labelsByReason.get(reason)!.push(entry.id === null ? "the draft" : JSON.stringify(entry.id));
    }
    return [...labelsByReason].map(([reason, labels]) => {
        const listed = labels.slice(0, maxListedIds).join(", ");
        const hidden = labels.length - maxListedIds;
        const action = background && reason === "semantic_review_required" ? backgroundReviewAction : pendingActions[reason];
        return `${action}: ${listed}${hidden > 0 ? ` and ${hidden} more` : ""}.`;
    });
}
