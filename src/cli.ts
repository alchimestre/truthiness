#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { bootstrap, checkedAt, checkout, readBlob } from "./bootstrap.ts";
import { load, parseProposal, publish, publishAuthorized, stage, type Graph } from "./store.ts";
import { anchoredPaths, index, query } from "./lookup.ts";
import { currentAxioms } from "./axioms.ts";
import { digest, recheckBatch, review } from "./review.ts";

const maxProposalBytes = 16 * 1024 * 1024;

async function run(args: string[]) {
    const [command, path, ...options] = args;
    if (!path) throw new Error("usage: truthiness validate STORE | axioms STORE SCOPE | query STORE TOKENIZER | index STORE SCOPE REVISION TOKENIZER | anchors STORE | stage PENDING | bootstrap STORE | review-pending STORE PENDING | publish STORE DIGEST | publish-authorized STORE APPROVAL_FILE");
    switch (command) {
        case "validate":
            requireOptions(options, 0);
            await load(path);
            return;
        case "axioms":
            requireOptions(options, 1);
            console.log(JSON.stringify(currentAxioms(await load(path), options[0])));
            return;
        case "query": {
            requireOptions(options, 1);
            const request = JSON.parse(await readInput());
            console.log(JSON.stringify(query(await load(path), request, input => countTokens(options[0], input))));
            return;
        }
        case "index": {
            requireOptions(options, 3);
            const [scope, revision, tokenizer] = options;
            const text = await index(await load(path), scope, revision, input => countTokens(tokenizer, input));
            process.stdout.write(text);
            return;
        }
        case "stage":
            requireOptions(options, 0);
            await stage(path, await readInput());
            return;
        case "anchors":
            requireOptions(options, 0);
            console.log(JSON.stringify({ paths: [...anchoredPaths(await load(path))].sort() }));
            return;
        case "bootstrap":
            requireOptions(options, 0);
            await bootstrapStore(path, process.cwd());
            return;
        case "review-pending":
            requireOptions(options, 1);
            await reviewPending(path, options[0], process.cwd());
            return;
        case "publish":
            requireOptions(options, 1);
            await publish(path, await readInput(), options[0]);
            return;
        case "publish-authorized":
            requireOptions(options, 1);
            await publishAuthorized(path, await readInput(), await Bun.file(options[0]).json());
            return;
        default:
            throw new Error(`unknown command: ${command}`);
    }
}

async function bootstrapStore(store: string, directory: string) {
    const revision = head(directory);
    const current = await loadIfPresent(store);
    if (!checkedAt(current, revision)) await seedLandmarks(store, directory, revision, current);
    await recheckStore(store, directory, revision).catch(error => console.error(`recheck skipped: ${error instanceof Error ? error.message : error}`));
}

async function seedLandmarks(store: string, directory: string, revision: string, current: Graph) {
    const { batch, sources } = bootstrap(directory, revision, new Set(Object.keys(current)));
    if (!batch) return;
    const result = review(batch, revision, path => sources.get(path));
    if (!result.approved) return;
    try {
        await publish(store, result.approved, digest(result.approved));
    } catch (error) {
        if (!checkedAt(await loadIfPresent(store), revision)) throw error;
        return;
    }
    console.log(`Bootstrapped ${result.published} source claims.`);
}

async function recheckStore(store: string, directory: string, revision: string) {
    const batch = recheckBatch(await loadIfPresent(store), revision);
    if (!batch) return;
    const result = review(batch, revision, path => readBlob(directory, revision, path), process.env.TRUTHINESS_REVIEWER);
    await publishNew(store, result.approved);
    if (result.published) console.log(`Rechecked ${result.published} claims; ${result.pending} need a fresh check.`);
}

async function reviewPending(store: string, pending: string, directory: string) {
    const file = Bun.file(pending);
    if (file.size > maxProposalBytes) throw new Error("input exceeds 16 MiB");
    const batch = decodeInput(await readFile(pending));
    const revision = head(directory);
    const result = review(batch, revision, path => readBlob(directory, revision, path), process.env.TRUTHINESS_REVIEWER);
    if (result.approved && head(directory) !== revision) throw new Error("HEAD changed during review; batch remains pending");
    await publishNew(store, result.approved);
    console.log(JSON.stringify({ published: result.published, pending: result.pending }));
}

async function publishNew(store: string, approved: string) {
    if (!approved) return;
    const current = await loadIfPresent(store);
    const additions = Object.values(parseProposal(approved)).filter(record => !isDeepStrictEqual(record, current[record.id]));
    const payload = additions.map(record => `${JSON.stringify(record)}\n`).join("");
    if (payload) await publish(store, payload, digest(payload));
}

async function loadIfPresent(path: string) {
    try {
        return await load(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return Object.create(null) as Awaited<ReturnType<typeof load>>;
    }
}

function head(directory: string): string {
    const revision = checkout(directory, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
    if (!revision) throw new Error("a Git checkout with a commit is required");
    return revision;
}

function requireOptions(options: string[], expected: number) {
    if (options.length !== expected) throw new Error("invalid arguments");
}

async function readInput() {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > maxProposalBytes) throw new Error("input exceeds 16 MiB");
        chunks.push(chunk);
    }
    return decodeInput(Buffer.concat(chunks, size));
}

function decodeInput(bytes: Buffer) {
    if (bytes.length > maxProposalBytes) throw new Error("input exceeds 16 MiB");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function countTokens(program: string, input: string) {
    const result = Bun.spawnSync([program], { stdin: Buffer.from(input), stderr: "ignore", timeout: 5000 });
    const text = result.stdout.toString().trim();
    if (result.exitCode !== 0 || !/^\d+$/.test(text)) return -1;
    const count = Number(text);
    return Number.isSafeInteger(count) ? count : -1;
}

try {
    await run(Bun.argv.slice(2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
