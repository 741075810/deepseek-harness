---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-bounded-compaction-calls

English | [中文](2026-10-08-bounded-compaction-calls.zh.md)

## Summary

Adds optional ordered llmCalls audit collections to compaction/summary and compaction/end. Each CompactionLlmCall retains a complete auxiliary request without signal or sessionId, full output, terminal finish reason, and optional usage. Successful multi-call transactions retain all settled attempts with their summary; a failed closing event retains terminal calls only when no summary was recorded.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-bounded-compaction-calls
baseline: false
changes:
  - root: "event:compaction/end"
    previous: "2026-09-11-initial"
    after: "2ee3512d353e891f66901068f7e9a68a86053b07e1a5823701ca5541df832ad1"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "77d7196a70c90af4eef29db5ccce9d835da00d0719aadd0afc82ac37e2975d2f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both additions are optional log-only data on existing event types. Existing records that omit llmCalls remain readable, and neither event names, Session header grammar, checkpoint messages, nor surface replacement fields change. No released Session generation or writer version changes. Restoring existing history and deriving its text checkpoint remain distinct from model-stream replay: the older single-call replay path does not reconstruct new multi-call collections, which require the updated llm-replay consumer. Call records require terminal settlement; unfinished throws and hangs still require explicit replay overrides. A recorded summary suppresses duplicate closing-event call publication.

<a id="verification"></a>
## Verification

The focused owner command pnpm exec vitest run packages/compaction/compaction-basic/tests packages/test-support/llm-replay/tests/llm-replay.spec.ts packages/compaction/compaction-image-offload/tests packages/llm/llm/tests --reporter=dot, with --coverage.include selections for packages/compaction/compaction-basic/src/, packages/llm/llm/src/index.ts, and packages/test-support/llm-replay/src/index.ts, passed 641 tests in 21 files. All six selected runtime files reached 100% statement, branch, function, and line coverage. The compaction-basic and llm-replay TypeScript reference-graph build passed.

Bundled Node v24.21.0 ran `node ./node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t 'compaction-bounded' --no-cache` with DSH_EXAMPLE_MODE=src, DSH_SNAPSHOT_MAX_CONCURRENCY=1, and DSH_SNAPSHOT_MAX_WORKERS=1. DSH_SNAPSHOT=refresh passed 2 tests with 138 skipped; DSH_SNAPSHOT=replay passed 2 tests with 139 skipped. `node ./node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts --no-cache` passed 3/3. Both new Session v4 fixtures derive complete llmCalls directly without replay overrides. After pnpm run build:lib:client exited successfully, the same headless filter command with DSH_EXAMPLE_MODE=lib, DSH_SNAPSHOT=replay, and both concurrency and worker limits set to 1 passed 2 tests with 139 skipped in 6.3 seconds; expected stderr remained clean.

The successful fixture retains 16 auxiliary calls: warm context overflow, 14 data fragments, and a merge. It commits one replacement and resumes the same turn. The failed fixture retains 3 settled auxiliary calls on compaction/end and commits no replacement. The largest complete request, including the actual session UUID's 44 serialized bytes, is 6451 bytes, equal to floor((8192 - 128) * 0.8). All 128 literal source lines, totaling 10154 bytes, survive warm input and ordered fragment reconstruction.

pnpm run doc-sync passed all 42 gates with 0 failed and 0 skipped, including Host build, documentation typecheck, site build, corpus-wide translation pairing, and persistence history checks. Type equivalence matched 470 canonical declarations and 470 paired derivatives. The compatibility classifier reports exactly two optional-property-added changes with requiresVersionBump:false.

<a id="dev-note"></a>
## Dev Note

None.
