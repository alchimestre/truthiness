import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const unknownTargetWarning = "Truthiness notes may quote the file this edit changes. After the edit, re-read that file before repeating or acting on its notes. The edit is not blocked.";
export const defaultProgram = fileURLToPath(new URL("./cli.ts", import.meta.url));
export const defaultTokenizer = fileURLToPath(new URL("../scripts/truthiness-tokenizer.sh", import.meta.url));
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
    const status = command("git", ["status", "--porcelain", "--untracked-files=all", "--", ":(top)", `:(top,exclude)${storeDirectory}`], cwd);
    if (status !== "") return undefined;
    return sourceRevision(cwd);
}

// Evidence is keyed to this, not HEAD: a commit touching only the store must not make every note stale.
export function sourceRevision(cwd: string) {
    const lastSourceChange = command("git", ["log", "-1", "--format=%H", "HEAD", "--", ":(top)", `:(top,exclude)${storeDirectory}`], cwd)?.trim();
    return lastSourceChange || command("git", ["rev-parse", "--verify", "HEAD^{commit}"], cwd)?.trim();
}

const storeDirectory = ".truthiness";
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
