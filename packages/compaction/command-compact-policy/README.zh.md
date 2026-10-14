---
description: "供使用基础压缩后端的部署按需启用的压力策略检查与更新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-compact-policy

[English](README.md) | 中文

## 概述

这个按需启用的插件向人类命令注册表添加 `/compact-policy [status|apply]`。它检查基础压缩（compaction）策略，可以持久化可编辑预设中的纯压力设置，同时更新已发布 agent（智能体）保留的后端代际。它不发起模型调用，保持模型窗口、请求上限、保留策略、自动模式、摘要路由与有效上限以及重试设置不变。

## 目录

- [使用本包](#use-this-package)
- [压力计算](#pressure-accounting)
- [应用与生命周期](#apply-and-lifetime)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

安装插件并将其挂载到 Host 组合中，置于所有 agent 预设之外。Host 必须提供 `commands`、`agents`、`agentPresets`、`configEditor` 和 `llm`；命令无需全局压缩后端。在选定配置档的补丁中添加以下插入项：

```yaml
- insert:
    - id: command-compact-policy
      name: '@deepseek-ai/dsh-command-compact-policy'
      config:
        thresholdRatio: 0.8
        headroomTokens: 16384
```

`thresholdRatio` 默认为 `0.8`，范围为 `(0, 1]`。`headroomTokens` 是可选的非负整数；省略时分别保留默认策略和各精确模型策略原有的余量。`apply` 替换默认策略及所有现有模型覆盖中的比例，保持提供方与模型覆盖列表不变。仅挂载插件不会改变任何压缩设置。

| 输入 | 结果 |
|---|---|
| `/compact-policy` 或 `/compact-policy status` | 检查已保存预设、已发布 agent，以及路由模型或目录模型的预算，不编辑它们。 |
| `/compact-policy apply` | 持久化可编辑的 literal 预设配置，然后更新已发布 agent 的受支持后端实例。 |
| 其他参数 | 返回 `Usage: /compact-policy [status|apply]`。 |

<a id="pressure-accounting"></a>
## 压力计算

Status 报告实际阈值 `floor(min(W × ratio, W − output reserve − headroom))`、限制项、保留 token 数及有效摘要上限。有路由记录的 Agent 使用最新持久请求 header 的 `maxTokens`，否则依次取精确适配器模型的默认上限和零。目录预览仅使用适配器默认值，不预测未来请求信封。接收命令的 Agent 与其保留的预设会单独标明。

提供方与模型目录取自 `llm.listProviders()` 和 `listModels()`。目录成员关系仅供参考：精确配置策略和已发布 Agent 的路由目标通过 `resolveModelInfo()` 独立解析，包括目录中未列出的路由。缺少容量或查询失败时会给出报告，不宣称已知有效阈值。修改已保存条目或活动后端前，会验证所有可用容量及相关的持久输出预留。

<a id="apply-and-lifetime"></a>
## 应用与生命周期

保存设置时，通过 `ConfigEditor.entries()` 与 `edit()` 操作根部可寻址的 `agent-preset` 条目，递归检查 literal `config.plugins` 分组。每个外层条目通过编辑器正常的验证、写入、协调与回滚实现原子更新。无关的原始字段与表达式保持原样。有条件或被禁用的分支以及含表达式的压缩配置会被跳过并报告；自定义后端或缺少后端的情况保持原样。重复应用已配置的保存条目会避免重新加载。

已保存预设重新加载后，现有会话继续保留加入时的代际。命令通过 `agents.list()` 获取所有已发布 Agent，使用 `agentPresets.serviceFor()` 读取其保留的隔离后端，再对每个共享实例调用一次 Basic 后端受支持的 `applyPressurePolicy()` 操作。该同步操作在替换不可变配置前验证完整候选值。未来 Agent 使用持久化后的版本。未发布的获取操作及独立的冷读租约属于本命令活动范围之外。

修改余量原本可能连带改变隐式摘要输出上限。后端的 `withPressurePolicy()` 仅在必要时固定全局或模型级 `maxTokens` 原有的有效值，不采用固定的替代输出上限。

完整 apply 并非跨条目事务。保存条目与活动后端的失败分别报告；先前成功的变更继续有效，部分失败返回错误结果。调用串行执行。取消会在进入下一条目前停止；已经开始的编辑器操作会先结算，随后 handler 完全停稳，其已提交变更继续有效。Host 日志中的取消诊断列出已完成条目。插件 dispose（资源释放）会先注销命令，再取消并等待活动 handler 完全停稳。命令生命周期事件仅进入日志。

<a id="further-exploration"></a>
## 进一步探索

- [基础后端](../compaction-basic/README.zh.md)拥有验证、压力更新及摘要上限保留逻辑。
- [配置编辑器](../../boot/config-editor/README.zh.md)拥有配置档持久化与协调逻辑。
- [预设注册表](../../preset/agent-preset-registry/README.zh.md)拥有保留代际及公开的服务查询。
- [压缩子系统](../../../docs/subsystems/compaction.zh.md)记录后端拥有的压力类型。

<a id="model-experience"></a>
## 模型体验

间接通过基础压缩后端的压力策略影响模型。命令与结果不会进入模型历史，也不发起模型请求。

#### KV Cache 影响

检查与配置更新保持当前模型历史前缀。后续压缩沿用后端正常的替换与缓存行为。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **仅支持 Basic 后端**——自定义后端在抽象 seam 上未公开压力更新 API，只报告而不修改。
- **仅持久化配置档可编辑的预设**——嵌套 Include 或代码拥有的声明通过本命令仅接受检查；其已发布的 Basic 后端仍可接受活动更新。
- **仅验证已知容量**——未知或后续改变的适配器容量仍遵循后端正常的目标使用时验证；目录预览不保证请求准入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作背景，点击展开</summary>

本开发备注是非权威的工作背景。未来任何压力选项都先由拥有者定义保留规则，再由本消费者持久化。

</details>
