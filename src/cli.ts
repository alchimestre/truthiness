#!/usr/bin/env bun
import { appendFile, readFile, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { sourceRevision } from "./agent.ts";
import { bootstrap, checkedAt, readBlob, readBlobsAt } from "./bootstrap.ts";
import { claimRecordIDs, load, parseProposal, publish, publishAuthorized, publishRechecks, stage, unstage, type Graph } from "./store.ts";
import { anchoredPaths, estimateTokens, index, query, staleDraft } from "./lookup.ts";
import { currentAxioms } from "./axioms.ts";
import { digest, recheckBatch, review, unchangedSinceReview, type PendingReason } from "./review.ts";

const maxProposalBytes = 16 * 1024 * 1024;

async function run(args: string[]) {
    const [command, path, ...options] = args;
    if (!path) throw new Error("usage: truthiness validate STORE | axioms STORE SCOPE | query STORE [TOKENIZER] | index STORE SCOPE REVISION [TOKENIZER] | stale STORE SCOPE REVISION | anchors STORE | stage PENDING | bootstrap STORE | review-pending STORE PENDING | publish STORE DIGEST | publish-authorized STORE APPROVAL_FILE | pending STORE PENDING_FILE | pending-approve STORE PENDING_FILE CLAIM_ID | pending-decline STORE PENDING_FILE CLAIM_ID");
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
            requireOptions(options, 0, 1);
            const request = JSON.parse(await readInput());
            console.log(JSON.stringify(query(await load(path), request, tokenCounter(options[0]))));
            return;
        }
        case "index": {
            requireOptions(options, 2, 1);
            const [scope, revision, tokenizer] = options;
            const text = await index(await load(path), scope, revision, tokenCounter(tokenizer));
            process.stdout.write(text);
            return;
        }
        case "stale":
            requireOptions(options, 2);
            process.stdout.write(staleDraft(await load(path), options[0], options[1]));
            return;
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
        case "pending":
            requireOptions(options, 1);
            await showNextPending(options[0], process.cwd());
            return;
        case "pending-approve":
            requireOptions(options, 2);
            await approvePending(path, options[0], options[1], process.cwd());
            return;
        case "pending-decline":
            requireOptions(options, 2);
            await declinePending(options[0], options[1]);
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
    const graph = await loadIfPresent(store);
    const batch = recheckBatch(graph, revision);
    if (!batch) return;
    const sources = readBlobsAt(directory, revision, observedPaths(batch));
    const earlier = new Map<string, string | undefined>();
    const read = (at: string, path: string) => {
        if (at === revision) return sources.get(path);
        const key = `${at}:${path}`;
        if (!earlier.has(key)) earlier.set(key, readBlob(directory, at, path));
        return earlier.get(key);
    };
    const result = review(batch, revision, path => sources.get(path), process.env.TRUTHINESS_REVIEWER, unchangedSinceReview(graph, revision, read));
    await publishNew(store, result.approved, payload => publishRechecks(store, payload));
    if (result.published) console.log(`Rechecked ${result.published} claims; ${result.pending} need a fresh check.`);
}

function observedPaths(batch: string): string[] {
    const records = batch.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const refs = records.filter(record => record.kind === "observation").map(record => String(record.source_ref));
    return [...new Set(refs.map(ref => ref.slice(ref.indexOf(":") + 1)))];
}

async function reviewPending(store: string, pending: string, directory: string) {
    const file = Bun.file(pending);
    if (file.size > maxProposalBytes) throw new Error("input exceeds 16 MiB");
    const batch = decodeInput(await readFile(pending));
    const revision = head(directory);
    const result = review(batch, revision, path => readBlob(directory, revision, path), process.env.TRUTHINESS_REVIEWER);
    if (result.approved && head(directory) !== revision) throw new Error("Source revision changed during review; batch remains pending");
    const published = await publishNew(store, result.approved);
    if (result.pending === 0) await unlink(pending).catch(() => console.error("Truthiness finished review but could not remove the staged copy."));
    console.log(JSON.stringify({ published, pending: result.pending, pendingReasons: result.pendingReasons }));
}

async function publishNew(store: string, approved: string, write = (payload: string) => publish(store, payload, digest(payload))) {
    if (!approved) return 0;
    const current = await loadIfPresent(store);
    const additions = Object.values(parseProposal(approved)).filter(record => !isDeepStrictEqual(record, current[record.id]));
    const payload = additions.map(record => `${JSON.stringify(record)}\n`).join("");
    if (payload) await write(payload);
    return additions.filter(record => record.kind === "claim").length;
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
    const revision = sourceRevision(directory);
    if (!revision) throw new Error("a Git checkout with a commit is required");
    return revision;
}

function requireOptions(options: string[], expected: number, optional = 0) {
    if (options.length < expected || options.length > expected + optional) throw new Error("invalid arguments");
}

function tokenCounter(program: string | undefined): (input: string) => number {
    return program ? input => countTokens(program, input) : estimateTokens;
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

type GraphRecord = Graph[string];
type PendingItem = { reason: PendingReason; claim: GraphRecord; observations: GraphRecord[] };

async function showNextPending(pending: string, directory: string) {
    const batch = await readPending(pending);
    const revision = head(directory);
    const result = review(batch, revision, path => readBlob(directory, revision, path), process.env.TRUTHINESS_REVIEWER);
    const queue = rankPending(parseProposal(batch), result.pendingReasons);
    const [next] = queue;
    if (!next) return;
    console.log(`${next.claim.id} (${next.reason})`);
    console.log(String(next.claim.text));
    for (const observation of next.observations) console.log(`  ${sourcePath(observation)}: ${String(observation.content)}`);
    if (queue.length > 1) console.log(`${queue.length - 1} more pending`);
}

async function approvePending(store: string, pending: string, claimID: string, directory: string) {
    const text = await readPending(pending);
    const graph = parseProposal(text);
    const batch = claimRecordIDs(graph, claimID).map(id => `${JSON.stringify(graph[id])}\n`).join("");
    const revision = head(directory);
    const result = review(batch, revision, path => readBlob(directory, revision, path), undefined, id => id === claimID);
    if (result.pending) throw new Error(`claim ${claimID} not published: ${result.pendingReasons[0].reason}`);
    if (head(directory) !== revision) throw new Error("Source revision changed during review; batch remains pending");
    const published = await publishNew(store, result.approved);
    await unstage(pending, claimID);
    console.log(JSON.stringify({ published }));
}

async function declinePending(pending: string, claimID: string) {
    await appendFile(`${pending}.declined`, await unstage(pending, claimID));
}

function rankPending(graph: Graph, pendingReasons: { id: string | null; reason: PendingReason }[]): PendingItem[] {
    const items = pendingReasons.flatMap(({ id, reason }): PendingItem[] => {
        if (id === null) return [];
        const links = Object.values(graph).filter(record => record.kind === "evidence_for" && record.to === id);
        const observations = links.map(link => graph[String(link.from)]);
        return [{ reason, claim: graph[id], observations }];
    });
    return items.sort((first, second) => second.observations.length - first.observations.length || Date.parse(String(second.claim.recorded_at)) - Date.parse(String(first.claim.recorded_at)));
}

function sourcePath(observation: GraphRecord) {
    const reference = String(observation.source_ref);
    return reference.slice(reference.indexOf(":") + 1);
}

async function readPending(pending: string) {
    if (Bun.file(pending).size > maxProposalBytes) throw new Error("input exceeds 16 MiB");
    return decodeInput(await readFile(pending));
}

try {
    await run(Bun.argv.slice(2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
