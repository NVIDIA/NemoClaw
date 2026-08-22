<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Agents

Pick one CPU-only agent to run inside the OpenShell sandbox:
[OpenClaw](https://openclaw.ai) (default), [Hermes](https://github.com/NousResearch/hermes-agent),
or [Deep Agents Code](https://docs.langchain.com/oss/python/deepagents/code/overview) — all
three mirror [`NVIDIA/NemoClaw/agents`](https://github.com/NVIDIA/NemoClaw/tree/main/agents).
Selection is a single flag (`AGENT_NAME`) to the same generic scripts — there is no
per-agent folder or duplicated chart. All three route inference identically — through
OpenShell's `https://inference.local/v1` proxy to the GPU inference pods this recipe
deploys (see the recipe root [`README.md`](../README.md#inference-runtimes)) — so the GPU
HPA and monitoring stack are unaffected by which agent you choose.

**Not yet independently validated end-to-end against a live cluster** (see
[Validated hardware](../README.md#validated-hardware)); OpenClaw is the most exercised of
the three. Please file an issue with anything you find while trying Hermes or Deep Agents
Code, especially on `dgx02`-class (8×H100) hardware.

## Comparison

| | OpenClaw | Hermes | Deep Agents Code |
|---|---|---|---|
| `AGENT_NAME` | `openclaw` | `hermes` | `deepagents` |
| Upstream | [`agents/openclaw`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/openclaw) | [`agents/hermes`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/hermes) | [`agents/langchain-deepagents-code`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/langchain-deepagents-code) |
| Shape | Long-running gateway + dashboard | Long-running gateway + dashboard | Terminal harness (one-shot per prompt) |
| Interactive entry | `openclaw tui` | `hermes` | `dcode` |
| Headless / scripted entry | gateway API (dashboard `:18789`) | gateway API (`:8642`), dashboard `:18789` | `dcode -n "<prompt>"` |
| Health surface used by this recipe | `openclaw plugins inspect nemoclaw --json` | `hermes --version` + `GET http://localhost:8642/health` | `dcode --version` + `config.toml` existence check |
| Runtime script | `run-agent-sandbox.sh` (foreground, keep terminal open) | `run-agent-sandbox.sh` (foreground, keep terminal open) | `run-agent-prompt.sh "<prompt>"` (one-shot, exits) |
| Default sandbox name | `nemoclaw-onprem` | `hermes-onprem` | `deepagents-onprem` |
| Default OpenShell provider name | `onprem-ollama` | `onprem-hermes` | `onprem-deepagents` |
| Upstream policy grants `integrate.api.nvidia.com`? | Yes — removed by `create-agent-sandbox.sh` | Yes — removed by `create-agent-sandbox.sh` | No — nothing to remove |

## Prerequisites

Everything in the recipe root [Prerequisites](../README.md#prerequisites) — no agent adds
anything beyond the shared OpenShell-path requirements (Docker Buildx + a registry every
node can pull from, the OpenShell CLI, and Agent Sandbox CRDs).

## Quick start

Run from the recipe root (`examples/recipes/nvidia/kubernetes-gpu-autoscaling/`) after
completing [steps 1–3](../README.md#quick-start) (clone, GPUs/DCGM, GPU inference + HPA)
and the shared [Agent Sandbox CRDs + OpenShell gateway](../README.md#openshell-details)
setup — both identical regardless of which agent you pick below.

Only run one agent's sandbox at a time unless you deliberately want to compare them side
by side (each uses its own sandbox/provider name by default, so running more than one
concurrently is possible but untested by this recipe).

```bash
# OpenClaw (default, most exercised by this recipe)
export AGENT_NAME=openclaw
export AGENT_SANDBOX_IMAGE=registry.example.com/team/nemoclaw-openclaw-k8s:v0.0.104
./scripts/build-agent-sandbox-image.sh
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh
./scripts/run-agent-sandbox.sh   # keep in foreground
```

```bash
# Hermes
export AGENT_NAME=hermes
export AGENT_SANDBOX_IMAGE=registry.example.com/team/nemoclaw-hermes-k8s:v0.0.104
./scripts/build-agent-sandbox-image.sh
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh
./scripts/run-agent-sandbox.sh   # keep in foreground
```

```bash
# Deep Agents Code — no gateway to keep running; run one-shot prompts instead
export AGENT_NAME=deepagents
export AGENT_SANDBOX_IMAGE=registry.example.com/team/nemoclaw-deepagents-k8s:v0.0.104
./scripts/build-agent-sandbox-image.sh
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh
./scripts/run-agent-prompt.sh "Explain this repository in one sentence."
# Interactive session instead of one-shot prompts (needs a TTY):
openshell sandbox exec -n deepagents-onprem -- dcode
```

Users do not paste an inference API key; the chart generates it and OpenShell injects
Bearer auth. `create-agent-sandbox.sh` strips `integrate.api.nvidia.com` from OpenClaw's
and Hermes's upstream policy (see [Shared policy notes](#shared-policy-notes)); Deep
Agents Code's policy never grants it, so there's nothing to remove there.

## Env vars

| Env var | Default | Purpose |
|---------|---------|---------|
| `AGENT_NAME` | — (required) | `openclaw`, `hermes`, or `deepagents` — selects everything else in this table |
| `AGENT_SANDBOX_IMAGE` | — (required) | Pushed image reference for the selected agent |
| `AGENT_SANDBOX_NAME` | See [Comparison](#comparison) | OpenShell sandbox name |
| `OPENSHELL_PROVIDER_NAME` | See [Comparison](#comparison) | OpenShell inference provider name |
| `AGENT_SANDBOX_CPU` / `AGENT_SANDBOX_MEMORY` | `2` / `4Gi` | Sandbox pod requests |
| `NEMOCLAW_TARGET_NODE` | unset (portable) | Pin the sandbox to a specific node |
| `VERIFY_HEALTH_TIMEOUT_SEC` | `90` | `verify-agent-sandbox.sh` timeout for OpenClaw/Hermes health checks |
| `VERIFY_SMOKE_TIMEOUT_SEC` | `30` | `verify-agent-sandbox.sh` timeout for Deep Agents Code's `dcode --version` / config check |
| `VERIFY_CURL_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for `/v1/models` and (OpenClaw/Hermes) `/v1/chat/completions` |
| `VERIFY_DCODE_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for Deep Agents Code's real `dcode -n "<prompt>"` call |

## Example verify output

**OpenClaw / Hermes** (gateway agents — `verify-agent-sandbox.sh` output shape is the same
for both; only the health-check step differs, see [Comparison](#comparison)):

```text
[verify] Checking hermes --version (timeout 90s)...
hermes --version OK.
[verify] GET http://localhost:8642/health (timeout 90s)...
Health probe OK.
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: llama3.2:3b
[verify] POST https://inference.local/v1/chat/completions
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox hermes-onprem reached https://inference.local for models and a real prompt (llama3.2:3b).
Runtime (optional foreground): AGENT_NAME=hermes ./scripts/run-agent-sandbox.sh
```

**Deep Agents Code** (terminal harness — no health probe, real `dcode -n` call instead):

```text
[verify] Checking dcode --version (timeout 30s)...
dcode --version OK.
[verify] Checking config.toml was generated (timeout 30s)...
config.toml OK.
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: llama3.2:3b
[verify] dcode -n (headless) — this is the real agent binary, not a curl probe (timeout 120s)
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox deepagents-onprem reached https://inference.local for models and a real prompt (llama3.2:3b).
NemoClaw/Deep Agents Code has no long-running gateway; run one-shot prompts with:
  AGENT_NAME=deepagents ./scripts/run-agent-prompt.sh "your prompt here"
```

## Shared policy notes

`create-agent-sandbox.sh` clones the pinned `NVIDIA/NemoClaw` release and passes the
selected agent's own upstream OpenShell sandbox policy file to `openshell sandbox create
--policy`:

- OpenClaw: `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`
- Hermes: `agents/hermes/policy-additions.yaml`
- Deep Agents Code: `agents/langchain-deepagents-code/policy-additions.yaml`

Despite the `policy-additions.yaml` filename, both files are complete, self-contained
OpenShell policies (not deltas merged onto another file) — verified against the upstream
schema (`version`, `filesystem_policy`, `landlock`, `process`, `network_policies`) before
this recipe used them the same way it already used `openclaw-sandbox.yaml`.

OpenClaw's and Hermes's upstream policies both grant `integrate.api.nvidia.com` as a
default inference endpoint; `create-agent-sandbox.sh` removes it after sandbox creation
because this recipe is on-premises-only (see `agent_common_grants_nvidia_endpoint` in
[`../scripts/agent-common.sh`](../scripts/agent-common.sh)). Deep Agents Code's policy
does not grant that endpoint in the first place, so its script only verifies the endpoint
is absent.

## Notes

- Hermes forwards two ports inside the sandbox per its manifest: the dashboard on `18789`
  and the OpenAI-compatible API on `8642`. Neither is exposed by `create-agent-sandbox.sh`
  today (it only uses `openshell sandbox exec` for the smoke checks above) — reaching the
  dashboard from outside the sandbox would need its own `kubectl port-forward` to the
  sandbox pod, which this recipe has not set up or validated.
- Deep Agents Code (`dcode`) has no dashboard, no gateway process, and no port to forward —
  it runs, answers, and exits for every invocation. There is nothing for the HPA/monitoring
  stack to distinguish as "the agent is up" beyond the sandbox pod itself being Ready.
- Deep Agents Code's upstream policy grants broader default network access than
  OpenClaw/Hermes (`github.com` / `api.github.com` read-write, `raw.githubusercontent.com`
  read-only) since it's a coding agent — review it if that's not desired for your
  environment. Its `landlock.compatibility: strict` (vs. `best_effort` for OpenClaw/Hermes)
  also means sandbox creation fails closed rather than silently degrading if the
  kernel/workspace mount cannot enforce the declared read-only paths.
- OpenShell `0.0.85` leaves sandboxes idle (`sleep infinity`); `run-agent-sandbox.sh`
  execs the agent's entrypoint in the foreground and must stay attached — it does not
  auto-restart. Combined topology (privilege drop + agent-specific tooling) may require
  capabilities like `SYS_ADMIN` / `NET_ADMIN` in a restrictive admission policy — check your
  cluster's Pod Security admission before assuming a clean create.

## Uninstall

Stop the running agent (`run-agent-sandbox.sh` for OpenClaw/Hermes; Deep Agents Code exits
after each `run-agent-prompt.sh` call — nothing to stop). With the OpenShell port-forward
still up:

```bash
openshell sandbox delete "${AGENT_SANDBOX_NAME:?set to the sandbox you created}"
openshell provider delete "${OPENSHELL_PROVIDER_NAME:?set to the provider you created}"
openshell gateway remove nemoclaw-k8s
rm -r -- "${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
```

Then, if no other sandboxes/agents are using the shared OpenShell gateway, see the recipe
root [Uninstall](../README.md#uninstall) for `helm uninstall openshell` and the GPU chart.
