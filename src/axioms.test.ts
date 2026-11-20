import { expect, test } from "bun:test";
import { currentAxioms } from "./axioms.ts";

test("an amendment does not revive its predecessor outside the new scope", () => {
    const root = { id: "old", kind: "axiom", scope: "repo" };
    const replacement = { id: "new", kind: "axiom", scope: "server" };
    const amendment = { kind: "supersedes", from: "new", to: "old" };
    const records = { old: root, new: replacement, amendment };
    expect(currentAxioms(records, "client")).toEqual([]);
    expect(currentAxioms(records, "server")).toEqual([replacement]);
});
