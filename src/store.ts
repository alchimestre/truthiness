import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

type DataObject = { [field: string]: unknown };
type StoreRecord = DataObject & { id: string; kind: string; recorded_at: string; recorded_by: string };
export type Graph = Record<string, StoreRecord>;

const relationshipKinds = new Set(["evidence_for", "depends_on", "conflicts_with", "supersedes"]);
const contextFields = new Set(["procedure", "revision", "source_digest", "conditions", "source_event_id", "check_session"]);
const recordFields: Record<string, Set<string>> = {
    axiom: new Set(["text", "scope", "anchors", "root_authority_ref"]),
    claim: new Set(["text", "scope", "anchors", "check"]),
    observation: new Set(["content", "source_ref", "captured_at", "context"]),
    evidence_for: new Set(["from", "to", "rationale", "assessment"]),
    depends_on: new Set(["from", "to", "rationale"]),
    conflicts_with: new Set(["from", "to", "rationale"]),
    supersedes: new Set(["from", "to", "rationale", "authority_ref", "evidence_refs"]),
};

export async function load(path: string): Promise<Graph> {
    const graph = decodeRecords(await readFile(path));
    validateGraph(graph);
    return graph;
}

/** Stage only after semantic verification and redaction; the narrow secret scan does not detect all credentials. */
export async function stage(path: string, payload: string): Promise<void> {
    const proposed = parseProposal(payload);
    if (!Object.keys(proposed).length) throw new Error("empty proposal");
    await withLock(path, async () => {
        const current = await readRecordsIfExists(path);
        const combined = mergeRecords(current, proposed);
        await atomicWrite(path, encodeGraph(combined));
    });
}

export function parseProposal(payload: string): Graph {
    return decodeRecords(Buffer.from(payload, "utf8"));
}

/** The caller must independently review the exact batch before publishing. This is not an OS permission boundary. */
export async function publish(path: string, payload: string, expectedDigest: string): Promise<void> {
    const proposed = checkBatch(payload, expectedDigest);
    for (const record of Object.values(proposed)) {
        if (record.kind === "axiom" || (record.kind === "supersedes" && record.authority_ref !== undefined)) {
            throw new Error("axiom creation or amendment requires trusted authorization via publishAuthorized");
        }
    }
    await writeBatch(path, proposed);
}

export type PublicationApproval = { digest: string; authorityObservationIDs: string[] };

/** Approval must come from an operator-controlled source; this function cannot establish human identity or isolate a same-user caller. */
export async function publishAuthorized(path: string, payload: string, approval: unknown): Promise<void> {
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) throw new Error("invalid operator approval");
    const candidate = approval as Record<string, unknown>;
    if (Object.keys(candidate).some(key => !["digest", "authorityObservationIDs"].includes(key)) ||
        typeof candidate.digest !== "string" ||
        !Array.isArray(candidate.authorityObservationIDs) ||
        !candidate.authorityObservationIDs.length ||
        !candidate.authorityObservationIDs.every(nonempty) ||
        new Set(candidate.authorityObservationIDs).size !== candidate.authorityObservationIDs.length) {
        throw new Error("invalid operator approval");
    }
    const proposed = checkBatch(payload, candidate.digest);
    await writeBatch(path, proposed, candidate.authorityObservationIDs);
}

function checkBatch(payload: string, expectedDigest: string): Graph {
    const digest = createHash("sha256").update(payload, "utf8").digest("hex");
    if (digest !== expectedDigest.toLowerCase()) throw new Error("review digest does not match exact batch");
    const proposed = parseProposal(payload);
    if (!Object.keys(proposed).length) throw new Error("empty publication batch");
    return proposed;
}

async function writeBatch(path: string, proposed: Graph, approvedAuthorityIDs: string[] = []): Promise<void> {
    await withLock(path, async () => {
        const current = await readGraphIfExists(path);
        const combined = mergeRecords(current, proposed);
        validateGraph(combined);
        if (approvedAuthorityIDs.length) validateAuthorityApproval(current, proposed, approvedAuthorityIDs);
        await atomicWrite(path, encodeGraph(combined));
    });
}

function validateAuthorityApproval(current: Graph, proposed: Graph, approvedIDs: string[]): void {
    const unused = new Set(approvedIDs);
    const requireAuthorityObservation = (id: unknown): void => {
        if (!nonempty(id) || !unused.has(id) || current[id]?.kind !== "observation") throw new Error("approval references must name existing authority observations");
        unused.delete(id);
    };
    let hasAxiomChange = false;
    for (const record of Object.values(proposed)) {
        if (record.kind === "axiom" && record.root_authority_ref !== undefined) {
            hasAxiomChange = true;
            requireAuthorityObservation(record.root_authority_ref);
        }
        if (record.kind === "supersedes" && record.authority_ref !== undefined) {
            hasAxiomChange = true;
            requireAuthorityObservation(record.authority_ref);
            for (const evidenceID of record.evidence_refs as string[]) {
                if (current[evidenceID]?.kind !== "observation") throw new Error("amendment evidence must reference existing observations");
            }
        }
    }
    if (!hasAxiomChange || unused.size) throw new Error("approval IDs must exactly match axiom authority references");
}

function decodeRecords(data: Buffer): Graph {
    const graph = Object.create(null) as Graph;
    if (data.length === 0) return graph;
    if (data[data.length - 1] !== 10) throw new Error("JSONL must end with a newline");
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, -1)).split("\n");
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line) throw new Error(`line ${index + 1} is empty`);
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch (error) {
            throw new Error(`line ${index + 1}: ${String(error)}`);
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`line ${index + 1} must be an object`);
        const record = value as StoreRecord;
        rejectDetectableSecrets(record);
        if (!nonempty(record.id)) throw new Error(`line ${index + 1}: id must be a nonempty string`);
        if (Object.hasOwn(graph, record.id)) throw new Error(`line ${index + 1}: duplicate id ${record.id}`);
        validateRecord(record.id, record);
        graph[record.id] = record;
    }
    return graph;
}

const knownSecretFormats = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\b(?:password|secret|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{12,}/i,
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
];

export function containsDetectableSecret(text: string): boolean {
    return knownSecretFormats.some(pattern => pattern.test(text));
}

function rejectDetectableSecrets(record: StoreRecord): void {
    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            if (containsDetectableSecret(value)) throw new Error(`record ${record.id} contains recognizable secret material`);
        } else if (Array.isArray(value)) {
            for (const item of value) visit(item);
        } else if (value && typeof value === "object") {
            for (const item of Object.values(value)) visit(item);
        }
    };
    visit(record);
}

function validateGraph(graph: Graph): void {
    for (const [id, record] of Object.entries(graph)) validateRecord(id, record);
    const dependencies = new Map<string, string[]>();
    const axiomParents = new Set<string>();
    const axiomChildren = new Set<string>();
    for (const record of Object.values(graph)) {
        if (!relationshipKinds.has(record.kind)) continue;
        const from = graph[String(record.from)];
        const to = graph[String(record.to)];
        if (!from || !to) throw new Error(`relationship ${record.id} has dangling endpoint`);
        switch (record.kind) {
            case "evidence_for":
                if (from.kind !== "observation" || to.kind !== "claim") throw new Error("evidence_for must link observation to claim");
                if (record.assessment) validateAssessmentReferences(graph, record, from);
                break;
            case "depends_on":
                if (from.kind !== "claim" || !["claim", "axiom"].includes(to.kind)) throw new Error("depends_on must link claim to claim or axiom");
                dependencies.set(String(record.from), [...(dependencies.get(String(record.from)) ?? []), String(record.to)]);
                break;
            case "conflicts_with":
                if (from.kind !== "claim" || to.kind !== "claim" || record.from === record.to) throw new Error("conflicts_with must link distinct claims");
                break;
            case "supersedes":
                if (from.kind !== to.kind || !["claim", "axiom"].includes(from.kind) || record.from === record.to) throw new Error("supersedes endpoints must be distinct claims or axioms of the same kind");
                if (from.kind === "axiom") {
                    if (!nonempty(record.authority_ref) || graph[record.authority_ref]?.kind !== "observation" ||
                        !Array.isArray(record.evidence_refs) ||
                        record.evidence_refs.some(id => graph[String(id)]?.kind !== "observation")) {
                        throw new Error("axiom supersession requires authorization and evidence observations");
                    }
                    if (axiomParents.has(String(record.to))) throw new Error("axiom lineage has multiple successors");
                    if (axiomChildren.has(String(record.from))) throw new Error("axiom amendment targets a version with a successor");
                    axiomParents.add(String(record.to));
                    axiomChildren.add(String(record.from));
                } else if (record.authority_ref !== undefined || record.evidence_refs !== undefined) {
                    throw new Error("claim supersession cannot carry axiom authorization");
                }
                break;
        }
    }
    if (hasCycle(dependencies)) throw new Error("depends_on cycle");
    const axiomEdges = new Map<string, string[]>();
    for (const record of Object.values(graph)) {
        if (record.kind === "supersedes" && graph[String(record.from)].kind === "axiom") {
            const from = String(record.from);
            const to = String(record.to);
            axiomEdges.set(from, [...(axiomEdges.get(from) ?? []), to]);
        }
    }
    if (hasCycle(axiomEdges)) throw new Error("axiom lineage cycle");
    for (const [id, record] of Object.entries(graph)) {
        if (record.kind !== "axiom") continue;
        const root = record.root_authority_ref !== undefined;
        const amended = axiomChildren.has(id);
        if (root === amended) throw new Error(`axiom ${id} must have exactly one root or amendment authority path`);
        if (root && graph[String(record.root_authority_ref)]?.kind !== "observation") throw new Error(`axiom ${id} has invalid root authority reference`);
    }
}

function validateRecord(id: string, record: StoreRecord): void {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`record ${id} must be an object`);
    const fields = recordFields[record.kind];
    if (!fields) throw new Error(`record ${id} has unknown kind ${String(record.kind)}`);
    const allowed = new Set(["id", "kind", "recorded_at", "recorded_by", ...fields]);
    for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`record ${id} has unknown field ${key}`);
    if (record.id !== id || !nonempty(record.recorded_by) || !utcTimestamp(record.recorded_at)) throw new Error(`record ${id} has invalid shared fields`);
    for (const field of fields) {
        if (["assessment", "root_authority_ref", "check", "authority_ref", "evidence_refs"].includes(field)) continue;
        if (!Object.hasOwn(record, field)) throw new Error(`record ${id} is missing ${field}`);
    }
    switch (record.kind) {
        case "axiom":
        case "claim": {
            if (!nonempty(record.text) || !nonempty(record.scope) || !Array.isArray(record.anchors)) throw new Error(`record ${id} has invalid text, scope or anchors`);
            for (const anchor of record.anchors as unknown[]) {
                if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) || !nonempty((anchor as StoreRecord).path)) throw new Error(`record ${id} has invalid anchor`);
                for (const [key, value] of Object.entries(anchor)) {
                    if (!["path", "symbol"].includes(key) || (key === "symbol" && typeof value !== "string")) throw new Error(`record ${id} has invalid anchor field ${key}`);
                }
            }
            if (record.kind === "claim" && !(record.check === null || typeof record.check === "string")) throw new Error(`record ${id} check must be a string or null`);
            if (record.kind === "axiom" && record.root_authority_ref !== undefined && !nonempty(record.root_authority_ref)) throw new Error(`record ${id} has invalid root authority reference`);
            break;
        }
        case "observation": {
            if (typeof record.content !== "string" || !nonempty(record.source_ref) || !utcTimestamp(record.captured_at) || !record.context || typeof record.context !== "object" || Array.isArray(record.context)) throw new Error(`record ${id} has invalid observation fields`);
            const context = record.context as Record<string, unknown>;
            for (const [key, value] of Object.entries(context)) if (!contextFields.has(key) || typeof value !== "string") throw new Error(`record ${id} has invalid context field ${key}`);
            break;
        }
        default:
            if (!nonempty(record.from) || !nonempty(record.to) || !nonempty(record.rationale)) throw new Error(`record ${id} has invalid relationship fields`);
            if (record.kind === "evidence_for" && record.assessment !== undefined) validateAssessment(record.assessment);
            if (record.kind === "supersedes" && (record.authority_ref !== undefined || record.evidence_refs !== undefined)) {
                if (!nonempty(record.authority_ref) || !Array.isArray(record.evidence_refs) || record.evidence_refs.length === 0 || !record.evidence_refs.every(nonempty)) throw new Error(`record ${id} has invalid axiom authorization references`);
            }
    }
}

function validateAssessment(value: unknown): asserts value is DataObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("assessment must be an object");
    const assessment = value as DataObject;
    for (const key of Object.keys(assessment)) if (!["outcome", "scope", "revision", "resolves"].includes(key)) throw new Error(`assessment has unknown field ${key}`);
    if (!["supports", "challenges", "disproves", "inconclusive"].includes(String(assessment.outcome)) || !nonempty(assessment.scope) || !nonempty(assessment.revision)) throw new Error("assessment has invalid outcome, scope or revision");
    if (assessment.resolves !== undefined && (!Array.isArray(assessment.resolves) || !assessment.resolves.length || !assessment.resolves.every(nonempty))) throw new Error("assessment resolves must be a nonempty string array");
}

function validateAssessmentReferences(graph: Graph, relationship: StoreRecord, observation: StoreRecord): void {
    const assessment = relationship.assessment as DataObject;
    const context = observation.context as DataObject;
    if (!nonempty(context.source_event_id) || !nonempty(context.check_session) || context.revision !== assessment.revision) throw new Error(`assessment ${relationship.id} lacks matching source-check context`);
    for (const targetID of (assessment.resolves as string[] | undefined) ?? []) {
        const target = graph[targetID];
        if (!target || target.kind !== "evidence_for" || target.to !== relationship.to || !target.assessment || (target.assessment as DataObject).scope !== assessment.scope || (target.assessment as DataObject).revision !== assessment.revision) throw new Error(`assessment ${relationship.id} has invalid resolution ${targetID}`);
    }
}

function mergeRecords(current: Graph, proposed: Graph): Graph {
    const combined = Object.assign(Object.create(null), current) as Graph;
    for (const [id, record] of Object.entries(proposed)) {
        if (Object.hasOwn(combined, id)) throw new Error(`duplicate id ${id}`);
        combined[id] = record;
    }
    return combined;
}

async function readGraphIfExists(path: string): Promise<Graph> {
    const graph = await readRecordsIfExists(path);
    validateGraph(graph);
    return graph;
}

async function readRecordsIfExists(path: string): Promise<Graph> {
    try {
        return decodeRecords(await readFile(path));
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return Object.create(null) as Graph;
        throw error;
    }
}


function encodeGraph(graph: Graph): Buffer {
    const records = Object.keys(graph).sort().map(id => `${canonical(graph[id])}\n`).join("");
    return Buffer.from(records);
}

async function withLock(path: string, operation: () => Promise<void>): Promise<void> {
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
        await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error(`store is locked: ${lockPath}; stale locks require operator recovery`);
        throw error;
    }
    try {
        await operation();
    } finally {
        await rmdir(lockPath);
    }
}

async function atomicWrite(path: string, data: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
        await file.writeFile(data);
        await file.sync();
        await file.close();
        await rename(temporary, path);
        const directory = await open(dirname(path), "r");
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } catch (error) {
        await file.close().catch(() => {});
        await rm(temporary, { force: true });
        throw error;
    }
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        const fields = value as Record<string, unknown>;
        return `{${Object.keys(fields).sort().map(key => `${JSON.stringify(key)}:${canonical(fields[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function hasCycle(edges: Map<string, string[]>): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string): boolean => {
        if (visiting.has(node)) return true;
        if (visited.has(node)) return false;
        visiting.add(node);
        for (const next of edges.get(node) ?? []) if (visit(next)) return true;
        visiting.delete(node);
        visited.add(node);
        return false;
    };
    for (const node of edges.keys()) if (visit(node)) return true;
    return false;
}

function utcTimestamp(value: unknown): value is string {
    return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function nonempty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
