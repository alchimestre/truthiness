import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const unknownTargetWarning = "Truthiness notes may quote the file this edit changes. After the edit, re-read that file before repeating or acting on its notes. The edit is not blocked.";
export const defaultProgram = fileURLToPath(new URL("./cli.ts", import.meta.url));
export const defaultTokenizer = fileURLToPath(new URL("../scripts/truthiness-tokenizer.sh", import.meta.url));
export const runWorker = promisify(execFile);

export function command(program: string, args: string[], cwd: string, input?: string) {
    const result = spawnSync(program, args, { cwd, input, encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return undefined;
    return result.stdout;
}

export function anchoredWarning(paths: string[]) {
    return `Truthiness notes quote ${paths.join(", ")}. After this edit, re-read the file before repeating or acting on those notes. The edit is not blocked.`;
}

export function cleanHead(cwd: string) {
    if (command("git", ["status", "--porcelain", "--untracked-files=all"], cwd) !== "") return undefined;
    return command("git", ["rev-parse", "HEAD"], cwd)?.trim();
}

const repositoryRoots = new Map<string, string | undefined>();

export function memoryPaths(cwd: string) {
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
        const { stdout } = await runWorker(program, ["review-pending", store, path], { cwd, timeout: 40_000 });
        const result = JSON.parse(stdout) as { published: number; pending: number };
        if (!Number.isSafeInteger(result.published) || result.published < 0 || !Number.isSafeInteger(result.pending) || result.pending < 0) {
            throw new Error("invalid review outcome");
        }
        if (result.pending === 0 && result.published > 0) {
            await unlink(path).catch(() => warn("Truthiness published the batch but could not remove its staged copy."));
        }
        return `${result.published} published, ${result.pending} pending automatic or operator review.`;
    } catch {
        const text = "Could not confirm automatic review; the staged batch was retained.";
        warn(text);
        return text;
    }
}
