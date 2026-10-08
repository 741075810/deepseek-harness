---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-08-bounded-compaction-calls

[English](2026-10-08-bounded-compaction-calls.md) | 中文

## 概述

为 compaction/summary 与 compaction/end 添加可选的有序 llmCalls 审计集合。每个 CompactionLlmCall 保留不含 signal、sessionId 的完整辅助请求、完整输出、终止原因与可选 usage。成功的多调用事务随摘要保留全部已结算尝试；失败闭合事件只在尚无摘要记录时保留终态调用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

两项新增字段都是现有事件类型上可选且仅写日志的数据。省略 llmCalls 的已有记录仍可读取，事件名、Session header 文法、检查点消息与表层替换字段均保持不变；已发布 Session generation 与写入版本保持不变。还原已有历史及派生其文本检查点，与模型流回放是两回事：旧版单次调用回放路径不会重建新的多调用集合，后者要求更新后的 llm-replay 消费方。调用记录要求终态结算，未完成的 throw 与 hang 仍要求显式回放覆盖。已记录摘要会阻止闭合事件重复发布调用集合。

<a id="verification"></a>
## 验证

负责人执行的定向命令 pnpm exec vitest run packages/compaction/compaction-basic/tests packages/test-support/llm-replay/tests/llm-replay.spec.ts packages/compaction/compaction-image-offload/tests packages/llm/llm/tests --reporter=dot，并以 --coverage.include 选择 packages/compaction/compaction-basic/src/、packages/llm/llm/src/index.ts 和 packages/test-support/llm-replay/src/index.ts，在 21 个文件中通过 641 个测试。六个所选运行时文件的语句、分支、函数与行覆盖率均为 100%。compaction-basic 与 llm-replay 的 TypeScript 引用图构建通过。

Bundled Node v24.21.0 执行 `node ./node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t 'compaction-bounded' --no-cache`，设置 DSH_EXAMPLE_MODE=src、DSH_SNAPSHOT_MAX_CONCURRENCY=1、DSH_SNAPSHOT_MAX_WORKERS=1。DSH_SNAPSHOT=refresh 通过 2 个测试、跳过 138 个；DSH_SNAPSHOT=replay 通过 2 个测试、跳过 139 个。`node ./node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts --no-cache` 通过 3/3。两个新 Session v4 夹具直接从完整 llmCalls 派生回放，均没有回放覆盖。pnpm run build:lib:client 成功结束后，同一 headless 筛选命令设置 DSH_EXAMPLE_MODE=lib、DSH_SNAPSHOT=replay，并将 concurrency 与 worker 上限均设为 1，在 6.3 秒内通过 2 个测试、跳过 139 个，期望 stderr 保持干净。

成功夹具保留 16 个辅助调用：热前缀上下文溢出、14 个数据分片及合并；只提交一次替换并在同一 turn 中继续。失败夹具在 compaction/end 上保留 3 个已结算辅助调用，替换次数为零。最大完整请求计入实际 session UUID 的 44 个序列化字节后为 6451 字节，等于 floor((8192 - 128) * 0.8)。原始 128 行、共 10154 字节的逐字内容在热前缀输入与有序分片重组中全部保留。

pnpm run doc-sync 的 42 项检查全部通过，0 失败、0 跳过，包含 Host 构建、文档类型检查、站点构建、全库 translation-pairing 与持久化历史检查。type-equivalence 匹配 470 个规范声明及 470 个配对衍生声明。兼容性分类器恰好报告两个 optional-property-added，且 requiresVersionBump:false。

<a id="dev-note"></a>
## 开发备注

无。
