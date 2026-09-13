# Fabric harness image recipes

The builder covers every adapter descriptor under `adapters/` in Fabric revision `51a28c1aefec56abd877070b6973d0a32a1e3003`: nine upstream adapters, plus our local OpenClaw adapter.
No upstream Fabric changes are required.

| `--harness` / YAML `harness` | Packaged harness | Inference protocol | Adapter selection |
| --- | --- | --- | --- |
| `deepagents` | Deep Agents 0.7.13 | OpenAI Chat Completions | `nvidia.fabric.langchain.deepagents` |
| `hermes` | Hermes 0.21.0, pinned source | OpenAI Chat Completions | `nvidia.fabric.hermes` |
| `openclaw` | OpenClaw 2026.9.4 | OpenAI Chat Completions | Local `nemoclaw.local.openclaw` |
| `claude` | Claude Agent SDK 0.2.120 and its bundled CLI | Anthropic Messages | `nvidia.fabric.claude` |
| `codex` | Codex SDK/CLI 0.144.4 | OpenAI Responses | `nvidia.fabric.codex` |
| `mini-swe-agent` | mini-SWE-agent 2.4.6 | OpenAI Chat Completions | `nvidia.fabric.mini-swe-agent` |
| `nooa` | NOOA / NOOA CLI 0.0.10 | OpenAI Chat Completions | `nvidia.fabric.nooa`, workflow `nvidia.nooa.coding-agent` |
| `nooa-bench` | NOOA bench 0.0.10 | OpenAI Chat Completions | `nvidia.fabric.nooa.bench-agent` |
| `remote-agent` | HTTP adapter 0.4.0 | OpenAI Chat Completions in this recipe | `nvidia.fabric.remote-agent` |
| `pi` | Pi 0.84.2 | OpenAI Responses with the selected catalog profile | `nvidia.fabric.pi` (TypeScript process adapter) |

Each Python dependency lock contains native wheel hashes.
Pi builds the TypeScript contract, shared lifecycle host, adapter, and harness using the npm lockfiles from the same checksum-verified Fabric archive.
Fabric-owned wheels are built locally.

Claude requires `inferenceProviders[].provider: anthropic`; the other recipes use `openai`.
NemoClaw creates the corresponding OpenShell provider credentials and base-URL fields, and probes the harness's protocol from inside the sandbox.
The provider type is immutable.
Older OpenAI provider state defaults to its existing behavior without replacement.
Endpoints must also pass OpenShell's own provider validation.
A successful Chat Completions call alone does not qualify Responses.

Pi's pinned adapter only accepts models from its catalog.
The recipe uses the `openai/gpt-4o` profile to select its wire format; OpenShell rewrites the outbound model to the primary route's YAML model.
The test verifies that rewrite.
Pi's catalog context limits and pricing describe that profile, not an arbitrary backend.

mini-SWE-agent uses `MSWEA_COST_TRACKING=ignore_errors` because the `primary` alias has no public price.
Its image and OpenShell launch environment both set this.

`remote-agent` forwards requests to an existing agent service through the declared route.
It does not install or operate that service.
NOOA selects its packaged CodingAgent target; the separate ARC solver target is not selected by this recipe.
Adapter coverage does not imply all workflow targets, settings, providers, MCP, telemetry, messaging, or model-specific capabilities have been qualified.

## Choose an example

Build and deploy with the [Fabric setup guide](../guides/fabric.md).
Each example selects its matching recipe:

| Recipe | Example |
| --- | --- |
| `deepagents` | [fabric.yaml](../../examples/fabric.yaml) |
| `hermes` | [fabric-hermes.yaml](../../examples/fabric-hermes.yaml) |
| `openclaw` | [fabric-openclaw.yaml](../../examples/fabric-openclaw.yaml) |
| `claude` | [fabric-claude.yaml](../../examples/fabric-claude.yaml) |
| `codex` | [fabric-codex.yaml](../../examples/fabric-codex.yaml) |
| `mini-swe-agent` | [fabric-mini-swe-agent.yaml](../../examples/fabric-mini-swe-agent.yaml) |
| `nooa` | [fabric-nooa.yaml](../../examples/fabric-nooa.yaml) |
| `nooa-bench` | [fabric-nooa-bench.yaml](../../examples/fabric-nooa-bench.yaml) |
| `remote-agent` | [fabric-remote-agent.yaml](../../examples/fabric-remote-agent.yaml) |
| `pi` | [fabric-pi.yaml](../../examples/fabric-pi.yaml) |

Refer to [validation results](../validation/index.md) for evidence and [Fabric tests](../validation/fabric.md) to reproduce the checks.
