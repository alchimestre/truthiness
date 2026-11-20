import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, publish, publishAuthorized, stage } from "./store.ts";

const observation = record("observation", "obs", {
    content: "checked", source_ref: "README.md", captured_at: "2026-11-20T00:00:00Z", context: {},
});
const claim = (id: string) => record("claim", id, {
    text: "A scoped claim", scope: "this repo", anchors: [], check: null,
});

function record(kind: string, id: string, fields: Record<string, unknown>) {
    return canonical({ id, kind, recorded_at: "2026-11-20T00:00:00Z", recorded_by: "run", ...fields }) + "\n";
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

async function tempPath() {
    return join(await mkdtemp(join(tmpdir(), "truthiness-store-")), "memory.jsonl");
}

describe("memory store", () => {
    test("loads canonical JSONL and validates references", async () => {
        const path = await tempPath();
        await writeFile(path, observation + claim("claim") + record("evidence_for", "edge", {
            from: "obs", to: "claim", rationale: "direct check",
        }));
        const graph = await load(path);
        expect(Object.keys(graph)).toHaveLength(3);
        expect(graph.claim.kind).toBe("claim");
    });

    test("rejects dependency cycles", async () => {
        const path = await tempPath();
        await writeFile(path, claim("a") + claim("b") + record("depends_on", "ab", {
            from: "a", to: "b", rationale: "premise",
        }) + record("depends_on", "ba", { from: "b", to: "a", rationale: "premise" }));
        await expect(load(path)).rejects.toThrow("cycle");
    });

    test("stages only to pending file", async () => {
        const path = await tempPath();
        const pending = `${path}.pending`;
        const original = claim("existing");
        await writeFile(path, original);
        await stage(pending, claim("proposal"));
        expect(await readFile(path, "utf8")).toBe(original);
        expect(Object.keys(await load(pending))).toEqual(["proposal"]);
    });

    test("publishes only the exact reviewed digest against current graph", async () => {
        const path = await tempPath();
        const payload = claim("proposal");
        const digest = createHash("sha256").update(payload).digest("hex");
        await expect(publish(path, payload, "wrong")).rejects.toThrow("digest");
        await publish(path, payload, digest);
        expect((await load(path)).proposal.kind).toBe("claim");
    });

    test("rejects axiom proposals without a trusted authorization channel", async () => {
        const path = await tempPath();
        const payload = record("axiom", "root", {
            text: "rule", scope: "repo", anchors: [], root_authority_ref: "authorization",
        });
        const digest = createHash("sha256").update(payload).digest("hex");
        await expect(publish(path, payload, digest)).rejects.toThrow("authorization");
    });
});

test("only an approved amendment can replace an axiom", async () => {
    const path = await tempPath();
    const root = record("axiom", "root", {
        text: "Original rule", scope: "repo", anchors: [], root_authority_ref: "obs",
    });
    await writeFile(path, observation + root);
    const amended = record("axiom", "amended", {
        text: "Replacement rule", scope: "repo", anchors: [],
    });
    const edge = { from: "amended", to: "root", rationale: "Verified change" };
    const unauthorized = amended + record("supersedes", "change", edge);
    const unauthorizedDigest = createHash("sha256").update(unauthorized).digest("hex");
    await expect(publish(path, unauthorized, unauthorizedDigest)).rejects.toThrow("authorization");
    expect(await readFile(path, "utf8")).toBe(observation + root);

    const approved = amended + record("supersedes", "change", {
        ...edge, authority_ref: "obs", evidence_refs: ["obs"],
    });
    const digest = createHash("sha256").update(approved).digest("hex");
    await expect(publish(path, approved, digest)).rejects.toThrow("authorization");
    await publishAuthorized(path, approved, { digest, authorityObservationIDs: ["obs"] });
    expect((await load(path)).change).toMatchObject({ from: "amended", to: "root", authority_ref: "obs" });
});
