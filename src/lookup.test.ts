import { describe, expect, test } from "bun:test";
import { anchoredPaths, index, query, type Records, type Request } from "./lookup.ts";

function records(outcome = "supports", scope = "service A", revision = "abc"): Records {
  return {
    claim: { id: "claim", kind: "claim", text: "Cache responses", scope },
    observation: { id: "observation", kind: "observation", content: "check passed", context: { source_event_id: "event-1", revision } },
    evidence: { id: "evidence", kind: "evidence_for", from: "observation", to: "claim", assessment: { outcome, scope, revision } },
  };
}

function request(overrides: Partial<Request> = {}): Request {
  return { mode: "id", id: "claim", scope: "service A", revision: "abc", ...overrides };
}

describe("lookup query", () => {
  test("returns a steering assessment only for exact scoped revision evidence", () => {
    const result = query(records(), request());
    expect(result.state).toBe("match");
    expect(result.matches[0]?.assessment.status).toBe("may_steer");
    expect(result.matches[0]?.assessment.evidence_ids).toEqual(["observation"]);
  });

  test("requires a recheck when scope or revision is unknown or different", () => {
    expect(query(records(), request({ scope: "service A and B" })).matches[0]?.assessment.status).toBe("recheck_required");
    expect(query(records(), request({ revision: "def" })).matches[0]?.assessment.status).toBe("recheck_required");
    expect(query(records(), request({ scope: "" })).matches[0]?.assessment.status).toBe("recheck_required");
  });

  test("does not infer truth from prose or untyped evidence", () => {
    const data = records();
    data.evidence = { id: "evidence", kind: "evidence_for", from: "observation", to: "claim", rationale: "This claim is supported" };
    expect(query(data, request()).matches[0]?.assessment.status).toBe("recheck_required");
  });

  test("identifies adverse outcomes and conflicts without counting duplicate event reports twice", () => {
    expect(query(records("disproves"), request()).matches[0]?.assessment.status).toBe("retired");
    const data = records();
    data.copy = { ...data.evidence, id: "copy" };
    expect(query(data, request()).matches[0]?.assessment.status).toBe("may_steer");
    data.observation2 = { ...data.observation, id: "observation2", context: { source_event_id: "event-2", revision: "abc" } };
    data.conflict = { id: "conflict", kind: "evidence_for", from: "observation2", to: "claim", assessment: { outcome: "disproves", scope: "service A", revision: "abc" } };
    expect(query(data, request()).matches[0]?.assessment.status).toBe("recheck_required");
  });
  test("applies resolutions to duplicate assessments and ignores ordinary inconclusive evidence", () => {
    const duplicate = records();
    duplicate.copy = { ...duplicate.evidence, id: "copy" };
    duplicate.observation2 = { id: "observation2", kind: "observation", context: { source_event_id: "event-2" } };
    duplicate.neutral = { id: "neutral", kind: "evidence_for", from: "observation2", to: "claim", assessment: { outcome: "inconclusive", scope: "service A", revision: "abc" } };
    expect(query(duplicate, request()).matches[0]?.assessment.status).toBe("may_steer");
    duplicate.withdrawal = { id: "withdrawal", kind: "evidence_for", from: "observation2", to: "claim", assessment: { outcome: "inconclusive", scope: "service A", revision: "abc", resolves: ["evidence"] } };
    expect(query(duplicate, request()).matches[0]?.assessment.status).toBe("recheck_required");
    const withoutObservedRevision = records();
    const context = withoutObservedRevision.observation.context;
    if (context && typeof context === "object" && "revision" in context) delete context.revision;
    expect(query(withoutObservedRevision, request()).matches[0]?.assessment.status).toBe("may_steer");
  });

  test("rejects unsupported modes and traversal hops distinctly", () => {
    expect(query(records(), { mode: "guess" } as Request).state).toBe("invalid_request");
    expect(query(records(), request({ mode: "graph", edge: "evidence", hops: 3 })).state).toBe("invalid_request");
  });

  test("traverses only explicitly requested applicable edges and records paths", () => {
    const data = records();
    const result = query(data, request({ mode: "graph", edge: "evidence", hops: 1 }));
    expect(result.matches.map(({ record }) => record.id)).toEqual(["claim", "observation"]);
    expect(result.matches.find(({ record }) => record.id === "observation")?.path).toEqual(["claim", "observation"]);
    expect(query(data, request({ mode: "graph", edge: "conflict" })).matches).toHaveLength(1);
  });

  test("fails closed when the response tokenizer fails", () => {
    expect(query(records(), request(), () => -1).state).toBe("unavailable");
  });
});

describe("lookup index", () => {
  test("emits eligible entries as exactly three escaped JSON string fields", () => {
    const data = records();
    data.claim.text = "cache <x> `y` &\u2028";
    const output = index(data, "service A", "abc", (value) => value.length);
    expect(output).toContain('"id":"claim"');
    expect(output).toContain('"summary":"cache \\u003cx\\u003e \\u0060y\\u0060 \\u0026\\u2028"');
    const entry = JSON.parse(output.split("\n")[2]!);
    expect(Object.keys(entry)).toEqual(["id", "summary", "scope"]);
  });

  test("omits out-of-scope and non-steering claims without truncation", () => {
    const data = records();
    data.other = { id: "other", kind: "claim", text: "other service", scope: "service B" };
    expect(index(data, "service A", "abc", (value) => value.length)).not.toContain('"id":"other"');
    expect(index(data, "service A", "other-revision", (value) => value.length)).not.toContain('"id":"claim"');
  });

  test("keeps index token and line caps and reports tokenizer failure", () => {
    const data = records();
    data.claim.text = "x".repeat(5000);
    const output = index(data, "service A", "abc", (value) => Math.ceil(value.length / 4));
    expect(output).toContain("Omitted eligible entries");
    expect(output.split("\n").filter(Boolean).length).toBeLessThanOrEqual(60);
    expect(() => index(records(), "service A", "abc", () => -1)).toThrow("token counter failed");
  });
});

describe("anchored paths", () => {
  test("lists paths of live claims only", () => {
    const claim = (path: string) => ({ kind: "claim", anchors: [{ path }] });
    const data: Records = {
      live: claim("src/review.ts"),
      superseded: claim("src/old.ts"),
      disproved: claim("src/wrong.ts"),
      axiom: { kind: "axiom", anchors: [{ path: "src/axiom.ts" }] },
      replacement: { kind: "supersedes", from: "live", to: "superseded" },
      refutation: { kind: "evidence_for", to: "disproved", assessment: { outcome: "disproves" } },
    };
    expect([...anchoredPaths(data)]).toEqual(["src/review.ts"]);
    expect(anchoredPaths({}).size).toBe(0);
  });
});
