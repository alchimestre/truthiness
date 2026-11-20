# Truthiness

Truthiness stores scoped project claims and evidence as canonical JSONL. It provides a bounded startup index, on-demand lookup, and a pending queue that cannot steer sessions.

| Command | Input and result |
| --- | --- |
| `truthiness validate STORE` | Validate canonical JSONL. |
| `truthiness axioms STORE SCOPE` | Print current applicable axioms separately. Only trust the operator-controlled store; authoritative project instructions take precedence. |
| `truthiness index STORE SCOPE REVISION TOKENIZER` | Print startup context. Pass an empty scope when the task is unknown. The tokenizer reads text from stdin and prints its exact input token count as an integer. |
| `truthiness query STORE TOKENIZER` | Read one JSON query from stdin; return token-bounded JSON. |
| `truthiness stage PENDING_FILE` | Read a JSONL batch from stdin; save it outside canonical memory. |
| `truthiness bootstrap STORE` | Seed an empty startup index from declarations and headings at `HEAD`. A `path: excerpt` citation in `.scratch` can seed another quote if it matches that tracked file at `HEAD`. |
| `truthiness review-pending STORE PENDING_FILE` | In the source checkout, independently verify a staged batch, publish supported claims, and print `{"published": N, "pending": M}`. The input file is not changed. |
| `truthiness publish STORE DIGEST` | Publish an independently reviewed empirical batch from stdin. `DIGEST` must match the SHA-256 of the exact reviewed bytes. |
| `truthiness publish-authorized STORE APPROVAL_FILE` | Operator only. Read an axiom batch from stdin and operator-controlled JSON with `digest` and `authorityObservationIDs`. |

```sh
bun link
```

```sh
bun test
```

1. Keep the canonical store and the pending directory outside the tracked checkout. OMP needs write access to both if it will stage and publish. This uses the current OS account; it does not prevent a session with filesystem access from writing directly to the store.
2. Give `bootstrap` a store outside the checkout and run it before `index`. When all existing claims require rechecking at the current revision, `bootstrap` can seed the index again. Recheck source on drift or conflict.
3. Stage a complete, redacted batch. Have the integration run `review-pending` on the staged file, not on model output sent directly to `publish`. Exact source quotes can pass without a model. Other claims need a reviewer, a matching source excerpt for every anchor at `HEAD`, and supporting evidence scoped to the claim. Checks, corrections to existing claims, and axioms do not pass this route. Axioms require operator approval via `publish-authorized`.
4. Set `TRUTHINESS_REVIEWER` to a trusted executable for semantic review. It reads one JSON object from stdin: `{"rubric":"...","candidates":[{"id":"...","text":"...","scope":"...","anchors":[{"path":"...","symbol":"..."}],"excerpts":[{"path":"...","text":"..."}]}],"sources":[{"path":"...","text":"..."}]}`. The anchor `symbol` is optional. `sources` contains complete committed files; review in that context, not from excerpts alone. Print a JSON array of supported candidate IDs. Claims stay pending if their source contains a detectable secret, the request exceeds 16 KiB, or the reviewer cannot return a valid decision. The secret scan is not exhaustive. Use a local reviewer if committed source must not leave the machine.
5. With OMP, set `TRUTHINESS_PENDING` to enable staging and review, and `TRUTHINESS_TOKENIZER` to enable startup indexing on a clean checkout. `truthiness_draft` reviews at closeout with `early: false` or in the current session with `early: true`. Unresolved batches remain pending and are not replayed at startup. `/truthiness off` disables startup context, edit warnings and drafting for this session; `/truthiness on` restores them. Set `TRUTHINESS_BOOTSTRAP=off` to skip startup seeding.

```sh
state="${XDG_STATE_HOME:-$HOME/.local/state}/truthiness"
tokenizer=token-count # executable that prints its stdin token count; omit to skip startup indexing
TRUTHINESS_COMMAND="$PWD/src/cli.ts" \
  TRUTHINESS_STORE="$state/canonical.jsonl" \
  TRUTHINESS_PENDING="$state/pending" \
  TRUTHINESS_TOKENIZER="$tokenizer" \
  omp --hook .omp/hooks/pre/truthiness.ts
```

For an optional OMP-backed reviewer, set `TRUTHINESS_REVIEWER="$PWD/.omp/truthiness-reviewer.sh"` in the launch environment. `TRUTHINESS_OMP_REVIEW_MODEL` selects its model. The CLI does not require OMP.

```sh
printf '%s\n' '{"mode":"id","id":"CLAIM_ID","scope":"repo","revision":"REVISION"}' | truthiness query "$TRUTHINESS_STORE" "$TRUTHINESS_TOKENIZER"
```
