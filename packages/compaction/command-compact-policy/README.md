---
description: "Opt-in pressure policy inspection and updates for deployments using the basic compaction backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-compact-policy

English | [中文](README.zh.md)

## Summary

This opt-in plugin adds `/compact-policy [status|apply]` to the human command registry. It inspects basic compaction policy and can persist pressure-only changes for editable presets while updating the backend generations retained by published agents. It makes no model call and leaves model windows, request caps, retention, automatic mode, summary routes and effective caps, and retries unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Pressure accounting](#pressure-accounting)
- [Apply and lifetime](#apply-and-lifetime)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Install and mount the plugin in the Host composition, outside every agent preset. The Host must supply `commands`, `agents`, `agentPresets`, `configEditor`, and `llm`; the command does not require a global compaction backend. Add this insertion to the selected profile's patch:

```yaml
- insert:
    - id: command-compact-policy
      name: '@deepseek-ai/dsh-command-compact-policy'
      config:
        thresholdRatio: 0.8
        headroomTokens: 16384
```

`thresholdRatio` defaults to `0.8`, in `(0, 1]`. `headroomTokens` is an optional non-negative integer; omit it to preserve the existing headroom separately for defaults and every exact-model policy. `apply` replaces the ratio in defaults and every existing model override; it never adds providers or model overrides. Mounting alone changes no compaction settings.

| Input | Result |
|---|---|
| `/compact-policy` or `/compact-policy status` | Inspect saved presets, published agents and routed or catalog model budgets without editing them. |
| `/compact-policy apply` | Persist editable literal preset configs, then update published agents' supported backend instances. |
| Other arguments | Return `Usage: /compact-policy [status|apply]`. |

<a id="pressure-accounting"></a>
## Pressure accounting

Status reports the actual threshold `floor(min(W × ratio, W − output reserve − headroom))`, its limiting term, retained tokens and effective summary cap. A routed Agent uses the latest durable request header's `maxTokens`, then the exact adapter model's default cap, then zero. Catalog previews use only the adapter default; they do not predict a future request envelope. The receiving Agent and its retained preset are identified separately.

Provider and model directories come from `llm.listProviders()` and `listModels()`. Catalog membership is advisory: exact configured policies and published Agents' routed targets are resolved independently with `resolveModelInfo()`, including unlisted routes. Missing capacity or lookup failure is reported without claiming an effective threshold. Every available capacity and associated durable output reservation is validated before a saved entry or live backend changes.

<a id="apply-and-lifetime"></a>
## Apply and lifetime

Saved changes use `ConfigEditor.entries()` and `edit()` on root-addressable `agent-preset` entries, recursively inspecting literal `config.plugins` groups. Each outer entry is atomic through the editor's normal validation, write, reconciliation and rollback. Unrelated raw fields and expressions are retained. Conditional or disabled branches and expression-based compaction configs are skipped and reported; unsupported or absent backends stay unchanged. Repeating an already-configured saved entry avoids a reload.

Existing sessions keep the generation they joined when a saved preset reloads. The command obtains every published Agent from `agents.list()` and its retained isolated backend with `agentPresets.serviceFor()`, then uses the Basic backend's supported `applyPressurePolicy()` operation once per shared instance. This synchronous operation validates the complete candidate before replacing its immutable config. Future Agents use the persisted revision. Unpublished acquisitions and detached cold-read leases are outside this command's live scope.

Changing headroom can otherwise change an implicit summary output cap. The backend's `withPressurePolicy()` pins the same previous effective global or per-model `maxTokens` only where needed; there is no fixed replacement output cap.

The full apply is not a cross-entry transaction. Saved-entry and live-backend failures are reported independently; earlier successful changes remain committed, and partial failure returns an error result. Invocations are serialized. Cancellation stops before the next entry; an already-started editor operation settles before the handler drains, and its committed changes remain. Cancellation diagnostics list completed entries in the Host log. Plugin disposal unregisters the command, cancels and drains active handlers. Command lifecycle events remain log-only.

<a id="further-exploration"></a>
## Further Exploration

- [Basic backend](../compaction-basic/README.md) owns validation, pressure updates and summary-cap preservation.
- [Configuration editor](../../boot/config-editor/README.md) owns profile persistence and reconciliation.
- [Preset registry](../../preset/agent-preset-registry/README.md) owns retained generations and public service lookup.
- [Compaction subsystem](../../../docs/subsystems/compaction.md) documents backend-owned pressure types.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the basic compaction backend's pressure policy. The command and its result never enter model history and make no model request.

#### KV Cache effect

Inspection and configuration updates preserve the current model-history prefix. A later compaction runs under the backend's normal replacement and cache behavior.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Basic backend only** — custom backends expose no pressure-update API on the abstract seam and are reported without mutation.
- **Profile-editable presets only** — declarations owned by nested Includes or code cannot be persisted through this command; their published Basic backends can still receive a live update.
- **Known capacities only** — unknown or subsequently changed adapter capacities remain subject to the backend's normal target-time validation; catalog previews are not request admission guarantees.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context. Any future pressure option needs an owner-side preservation rule before this consumer persists it.

</details>
