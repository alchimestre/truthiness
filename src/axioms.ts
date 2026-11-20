type RecordData = Record<string, unknown>;

export function currentAxioms(records: Record<string, RecordData>, scope: string): RecordData[] {
    const replaced = new Set<unknown>();
    for (const record of Object.values(records)) {
        if (record.kind !== "supersedes" || typeof record.from !== "string") continue;
        if (records[record.from]?.kind === "axiom") replaced.add(record.to);
    }
    return Object.keys(records).sort().flatMap(id => {
        const record = records[id];
        if (record.kind !== "axiom" || replaced.has(id)) return [];
        return record.scope === "repo" || record.scope === scope ? [record] : [];
    });
}
