<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Agent selection

Pick one CPU-only agent to run inside the OpenShell sandbox:
[OpenClaw](https://openclaw.ai) (default), [Hermes](https://github.com/NousResearch/hermes-agent),
or [Deep Agents Code](https://docs.langchain.com/oss/python/deepagents/code/overview) — all
three mirror [`NVIDIA/NemoClaw/agents`](https://github.com/NVIDIA/NemoClaw/tree/main/agents).
Selection is a single flag (`AGENT_NAME`) to the same generic scripts — there is no
per-agent folder or duplicated chart. All three route inference identically — through
OpenShell's `https://inference.local/v1` proxy to the GPU inference pods this recipe
deploys (see [`README.md`](README.md#inference-runtimes)) — so the GPU HPA and monitoring
stack are unaffected by which agent you choose. That routing is uniform, but not every
agent × `inference.runtime` pairing is equally documented or exercised upstream — see
[Agent and runtime support](README.md#agent-and-runtime-support) before picking one,
especially for Deep Agents Code.

**Not yet independently validated end-to-end against a live cluster** (see
[Validated hardware](README.md#validated-hardware)); OpenClaw is the most exercised of
the three. Please file an issue with anything you find while trying Hermes or Deep Agents
Code, especially on `dgx02`-class (8×H100) hardware.

## Comparison

| | OpenClaw | Hermes | Deep Agents Code |
|---|---|---|---|
| `AGENT_NAME` | `openclaw` | `hermes` | `deepagents` |
| Upstream | [`agents/openclaw`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/openclaw) | [`agents/hermes`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/hermes) | [`agents/langchain-deepagents-code`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/langchain-deepagents-code) |
| Shape | Long-running gateway + dashboard | Long-running gateway + dashboard | Terminal harness (one-shot per prompt) |
| Interactive entry | `openclaw tui` | `hermes` | `dcode` |
| Headless / scripted entry (used by this recipe's example query) | `openclaw agent exec "<prompt>"` (embedded, no Gateway needed) | `hermes -z "<prompt>"` (embedded one-shot) | `dcode -n "<prompt>"` |
| Health surface used by this recipe | `openclaw plugins inspect nemoclaw --json` | `hermes --version` + `config.yaml` existence check | `dcode --version` + `config.toml` existence check |
| Runtime script | `run-agent-sandbox.sh` (foreground, keep terminal open) | `run-agent-sandbox.sh` (foreground, keep terminal open) | `run-agent-prompt.sh "<prompt>"` (one-shot, exits) |
| Default sandbox name | `nemoclaw-onprem` | `hermes-onprem` | `deepagents-onprem` |
| Default OpenShell provider name | `onprem-ollama` | `onprem-hermes` | `onprem-deepagents` |
| Upstream policy grants `integrate.api.nvidia.com`? | Yes — removed by `create-agent-sandbox.sh` | Yes — removed by `create-agent-sandbox.sh` | No — nothing to remove |

## Selecting an agent

There is only **one** Quick start to run — [`README.md`](README.md#quick-start).
This page has no commands of its own to copy-paste; it's reference material for whichever
`AGENT_NAME` you set in [step 4](README.md#4-agent-sandbox-image-openshell) of that
Quick start (`openclaw`, `hermes`, or `deepagents` — see [Comparison](#comparison) below).
The only place the three agents' commands actually diverge is the last line of
[step 5](README.md#5-connect-cli-and-create-sandbox): OpenClaw/Hermes keep
`run-agent-sandbox.sh` in the foreground, Deep Agents Code runs one-shot prompts with
`run-agent-prompt.sh "<prompt>"` instead (there's also `openshell sandbox exec -n
deepagents-onprem -- dcode` for an interactive session — needs a TTY).

Only run one agent's sandbox at a time unless you deliberately want to compare them side
by side (each uses its own sandbox/provider name by default, so running more than one
concurrently is possible but untested by this recipe).

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
| `VERIFY_HEALTH_TIMEOUT_SEC` | `90` | `verify-agent-sandbox.sh` timeout for OpenClaw's plugin inspect and Hermes's `--version` check |
| `VERIFY_SMOKE_TIMEOUT_SEC` | `30` | `verify-agent-sandbox.sh` timeout for the Hermes/Deep Agents Code config-file existence checks and Deep Agents Code's `dcode --version` |
| `VERIFY_CURL_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for the `/v1/models` GET (network-routing check only, all three agents) |
| `VERIFY_OPENCLAW_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for OpenClaw's real `openclaw agent exec "<prompt>"` call |
| `VERIFY_HERMES_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for Hermes's real `hermes -z "<prompt>"` call |
| `VERIFY_DCODE_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for Deep Agents Code's real `dcode -n "<prompt>"` call |

## Example verify output

All three agents follow the same shape: a health/version check, a build-time config check
(Hermes/Deep Agents Code only), a `/v1/models` GET that only proves the sandbox's network
route to inference is reachable, and finally a **real prompt through that agent's own
headless CLI** — never a curl straight to `/v1/chat/completions` — so a pass actually
proves the agent itself can answer, not just that the network path exists.

**OpenClaw**:

```text
[verify] Inspecting nemoclaw plugin (timeout 90s)...
Plugin inspect OK.
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: llama3.2:3b
[verify] openclaw agent exec (headless) — this is the real agent binary, not a curl probe (timeout 120s)
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox nemoclaw-onprem reached https://inference.local for models and answered a real prompt through NemoClaw/OpenClaw (llama3.2:3b).
Runtime (optional foreground): AGENT_NAME=openclaw ./scripts/run-agent-sandbox.sh
```

**Hermes**:

```text
[verify] Checking hermes --version (timeout 90s)...
hermes --version OK.
[verify] Checking config.yaml was generated (timeout 30s)...
config.yaml OK.
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: llama3.2:3b
[verify] hermes -z (headless) — this is the real agent binary, not a curl probe (timeout 120s)
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox hermes-onprem reached https://inference.local for models and answered a real prompt through NemoClaw/Hermes (llama3.2:3b).
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
OK: sandbox deepagents-onprem reached https://inference.local for models and answered a real prompt through NemoClaw/Deep Agents Code (llama3.2:3b).
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
[`scripts/agent-common.sh`](scripts/agent-common.sh)). Deep Agents Code's policy
does not grant that endpoint in the first place, so its script only verifies the endpoint
is absent.

## Notes

- `create-agent-sandbox.sh`'s and `verify-agent-sandbox.sh`'s "example query" step runs a
  real prompt through each agent's own headless CLI — `openclaw agent exec "<prompt>"`,
  `hermes -z "<prompt>"`, or `dcode -n "<prompt>"` — never a curl straight to
  `https://inference.local/v1/chat/completions`. The `/v1/models` GET earlier in both
  scripts already proves the sandbox's network route to inference is reachable; a curl-based
  "example query" on top of that would only re-prove the same routing and would not exercise
  OpenClaw's or Hermes's own model routing, config, or agent loop at all.
- Hermes forwards two ports inside the sandbox per its manifest: the dashboard on `18789`
  and the OpenAI-compatible API on `8642`. Neither is exposed by `create-agent-sandbox.sh`
  today (it only uses `openshell sandbox exec` for the smoke checks above) — reaching the
  dashboard from outside the sandbox would need its own `kubectl port-forward` to the
  sandbox pod, which this recipe has not set up or validated. Neither port is listening
  yet at `create-agent-sandbox.sh` / `verify-agent-sandbox.sh` time either, since nothing
  has started the Hermes gateway process (see the idle-sandbox note below) — that's why
  those two scripts check for Hermes's build-time-generated `config.yaml` instead of
  probing `:8642` directly; only `run-agent-sandbox.sh` actually starts the gateway and
  makes port `8642` reachable.
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
- Current NemoClaw guidance does not document pairing Deep Agents Code with a local
  Ollama inference backend, and this recipe hasn't independently validated any Deep
  Agents Code + `inference.runtime` combination end-to-end (see
  [Agent and runtime support](README.md#agent-and-runtime-support)). Both the full manual
  [Quick start](README.md#quick-start) and `scripts/try-it.sh` will run
  `AGENT_NAME=deepagents` with `inference.runtime=ollama` if you ask for it (neither
  blocks the combination) — `try-it.sh` just prints a warning first. Treat that specific
  pairing as unsupported/untested, not a documented option.

## Uninstall

See [Uninstall](README.md#uninstall) — it already covers all three agents' default
sandbox/provider names.
