#!/usr/bin/env bun
import { load, publish, publishAuthorized, stage } from "./store.ts";
import { index, query } from "./lookup.ts";
import { currentAxioms } from "./axioms.ts";

async function run(args: string[]) {
    const [command, path, ...options] = args;
    if (!path) throw new Error("usage: truthiness validate STORE | axioms STORE SCOPE | query STORE TOKENIZER | index STORE SCOPE REVISION TOKENIZER | stage PENDING | publish STORE DIGEST | publish-authorized STORE APPROVAL_FILE");
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

function requireOptions(options: string[], expected: number) {
    if (options.length !== expected) throw new Error("invalid arguments");
}

async function readInput() {
    const maxBytes = 16 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("input exceeds 16 MiB");
        chunks.push(chunk);
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
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
