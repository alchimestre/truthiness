# Truthiness

Truthiness stores scoped project claims and evidence as canonical JSONL. It provides a bounded startup index, on-demand lookup, and a pending queue that cannot steer sessions.

| Command | Input and result |
| --- | --- |
| `truthiness validate STORE` | Validate canonical JSONL. |
| `truthiness axioms STORE SCOPE` | Print current applicable axioms separately. Only trust the operator-controlled store; authoritative project instructions take precedence. |
| `truthiness index STORE SCOPE REVISION TOKENIZER` | Print startup context. Pass an empty scope when the task is unknown. The tokenizer reads text from stdin and prints its exact input token count as an integer. |
| `truthiness query STORE TOKENIZER` | Read one JSON query from stdin; return token-bounded JSON. |
| `truthiness stage PENDING_FILE` | Read a JSONL batch from stdin; save it outside canonical memory. |
| `truthiness publish STORE DIGEST` | Read an independently reviewed empirical batch from stdin. `DIGEST` is the SHA-256 of the exact approved bytes. |
| `truthiness publish-authorized STORE APPROVAL_FILE` | Operator only. Read an axiom batch from stdin and operator-controlled JSON with `digest` and `authorityObservationIDs`. |

```sh
bun link
```

```sh
bun test
```

1. Keep the canonical store and the pending directory outside the tracked checkout. OMP needs write access to both if it will stage and publish. This uses the current OS account; it does not prevent a session with filesystem access from writing directly to the store.
2. Before publication, independently verify source-event identity, check outcomes, scope, and redaction. For axioms, verify explicit human authorization of the assertion, scope, predecessor and evidence as applicable. Record the authorization observation first, then bind its ID and the exact axiom batch digest in an operator-controlled approval file. Never publish pending files automatically on restart.
3. In prompt mode, run `index` for the current revision before using memory. Recheck against source on drift or conflict. Run `stage` on closeout or for an urgent correction.
4. For OMP hooks, set `TRUTHINESS_COMMAND` and `TRUTHINESS_STORE` in the launch environment. Set `TRUTHINESS_PENDING` to enable staging and `TRUTHINESS_TOKENIZER` to enable startup indexing on a clean checkout. Use trusted executables. Invoke `truthiness_draft` with a complete, redacted `jsonl` batch and `early: false` for shutdown staging, or `early: true` to stage immediately. Run `/truthiness off` to disable indexing, the edit warning, drafting and staging for the rest of the session; `/truthiness on` restores them, and `/truthiness status` reports the current state. The choice persists across resume and compaction.
5. In a different session from the one that proposed the batch, review it against the source. Invoke `truthiness_publish` with the exact reviewed `jsonl` and its SHA-256 `digest`. Both tools are under `xd://` when tools are mounted. Use `publish-authorized` separately for human-approved axioms.

```sh
state="${XDG_STATE_HOME:-$HOME/.local/state}/truthiness"
tokenizer=token-count # executable that prints its stdin token count; omit to skip startup indexing
TRUTHINESS_COMMAND="$PWD/src/cli.ts" \
  TRUTHINESS_STORE="$state/canonical.jsonl" \
  TRUTHINESS_PENDING="$state/pending" \
  TRUTHINESS_TOKENIZER="$tokenizer" \
  omp --hook .omp/hooks/pre/truthiness.ts
```

```sh
printf '%s\n' '{"mode":"id","id":"CLAIM_ID","scope":"repo","revision":"REVISION"}' | truthiness query "$TRUTHINESS_STORE" "$TRUTHINESS_TOKENIZER"
```
