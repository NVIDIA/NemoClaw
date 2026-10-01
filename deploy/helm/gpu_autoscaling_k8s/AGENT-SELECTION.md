<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Agent selection

Choose one CPU-only agent type per OpenShell sandbox (`AGENT_NAME`). Pairing uses one sandbox; the OpenClaw e2e uses many sandboxes (one per end user) on the same GPU HPA:
[OpenClaw](https://openclaw.ai) (default and most exercised),
[Hermes](https://github.com/NousResearch/hermes-agent), or
[Deep Agents Code](https://docs.langchain.com/oss/python/deepagents/code/overview).
Set `AGENT_NAME` to select the agent. Each uses OpenShell's
`https://inference.local/v1` proxy and the same GPU inference, HPA, and monitoring stack;
see [README Quick start](README.md#6-e2e-test-with-multiple-end-users-and-sandboxes).

Official host-installer quickstarts (this branch):
[OpenClaw](../../../docs/get-started/quickstart.mdx),
[Hermes](../../../docs/get-started/quickstart-hermes.mdx), and
[LangChain Deep Agents Code](../../../docs/get-started/quickstart-langchain-deepagents-code.mdx).
Published copies: [OpenClaw](https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart),
[Hermes](https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/quickstart), and
[Deep Agents Code](https://docs.nvidia.com/nemoclaw/latest/user-guide/deepagents/get-started/quickstart).

This recipe does **not** use `nemoclaw` / `nemohermes` / `nemo-deepagents launch`.
Those commands are the host Docker installer path. Here the CPU agent lives in an
OpenShell Kubernetes sandbox and talks to GPU inference through
`https://inference.local/v1`. Confirm each agent with the [Recipe quick start](#recipe-quick-start).

## Comparison

| | OpenClaw | Hermes | Deep Agents Code |
|---|---|---|---|
| `AGENT_NAME` | `openclaw` | `hermes` | `deepagents` |
| Upstream | [`agents/openclaw`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/openclaw) | [`agents/hermes`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/hermes) | [`agents/langchain-deepagents-code`](https://github.com/NVIDIA/NemoClaw/tree/main/agents/langchain-deepagents-code) |
| Shape | Long-running gateway + dashboard | Long-running gateway + dashboard | Terminal harness (one-shot per prompt) |
| Interactive entry | `openclaw tui` | `hermes` | `dcode` |
| Headless / scripted entry (used by verification) | `openclaw agent --agent main -m "<prompt>"` (requires its gateway) | `hermes -z "<prompt>"` | `dcode -n "<prompt>"` |
| Health surface used by this recipe | `:18789/health` + plugin inspection | `:8642/health` + version/config checks | `dcode --version` + `config.toml` check (no gateway) |
| Runtime script | `run-agent-sandbox.sh` (foreground, keep terminal open) | `run-agent-sandbox.sh` (foreground, keep terminal open) | `run-agent-prompt.sh "<prompt>"` (one-shot, exits) |
| Default sandbox name | `nemoclaw-onprem` | `hermes-onprem` | `deepagents-onprem` |
| Default OpenShell provider name | `onprem-ollama` | `onprem-hermes` | `onprem-deepagents` |
| Upstream policy grants `integrate.api.nvidia.com`? | Yes — removed by `create-agent-sandbox.sh` | Yes — removed by `create-agent-sandbox.sh` | No — nothing to remove |
| Official installer CLI (`NEMOCLAW_AGENT`) | `nemoclaw` (`openclaw`) | `nemohermes` (`hermes`) | `nemo-deepagents` (`langchain-deepagents-code`) |
| Official first prompt | `nemoclaw launch <sandbox>` or `openclaw tui` | `nemohermes launch <sandbox>` or `hermes` | `nemo-deepagents launch <sandbox>` or `dcode` / `dcode -n` |

## Recipe quick start

Run **one** of the loops below after the GPU chart and OpenShell gateway are up.
Shared prerequisites (do these once): [README Quick start](README.md#quick-start)
steps 1–3 (GPU inference + HPA), Agent Sandbox CRDs, `install-openshell-k8s.sh`,
and a live OpenShell port-forward:

```bash
./scripts/openshell-port-forward.sh
```

Keep that port-forward attached. Use a second terminal in
`deploy/helm/gpu_autoscaling_k8s`. Source `versions.env` there. The GPU Helm
chart is agent-neutral; only the sandbox image and `AGENT_NAME` change.

The loops below are optional pairing (one sandbox, no HPA). The DGX e2e path does **not** use them: `agentscaling_gpuutil.sh` / `agentscaling_latency.sh` (OpenClaw), `agentscaling_hermes_gpuutil.sh` / `agentscaling_hermes_latency.sh` (Hermes), and `agentscaling_deepagents_gpuutil.sh` / `agentscaling_deepagents_latency.sh` (Deep Agents + NIM) create the sandboxes. See [README Quick start](README.md#quick-start).

The loops below are the recipe path. Optional developer pairing tests (one GPU
replica, no Kubernetes autoscaling, no load test; not required for HPA) live in
[`scripts/README.md`](scripts/README.md):
[`scripts/test-openclaw-ollama.sh`](scripts/test-openclaw-ollama.sh),
[`scripts/test-hermes-nim.sh`](scripts/test-hermes-nim.sh),
[`scripts/test-deepagents-vllm.sh`](scripts/test-deepagents-vllm.sh).

### OpenClaw

Matches the official [OpenClaw quickstart](../../../docs/get-started/quickstart.mdx)
harness (`openclaw tui` / `openclaw agent --agent main -m`) on this Kubernetes path.

```bash
source versions.env
export AGENT_NAME=openclaw
export AGENT_SANDBOX_IMAGE=ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:bd935f0198b99889d9479fea123b62a59e3797da13e392dcc2160f114216c1ba
export INFERENCE_MODEL=llama3.2:3b   # must match the GPU chart model
./scripts/create-agent-sandbox.sh
```

Terminal 2 — keep attached (starts `/usr/local/bin/nemoclaw-start`):

```bash
export AGENT_NAME=openclaw
./scripts/run-agent-sandbox.sh
```

Terminal 3 — real headless prompt through `openclaw agent --agent main -m`:

```bash
export AGENT_NAME=openclaw
export INFERENCE_MODEL=llama3.2:3b
./scripts/verify-agent-sandbox.sh
```

Optional pairing test (not required for autoscaling): [`scripts/test-openclaw-ollama.sh`](scripts/test-openclaw-ollama.sh).

Multi-user HPA e2e: N sandboxes (one per end user). This DGX demo uses `E2E_USERS=5`. Provision with [`scripts/agentscaling_gpuutil.sh`](scripts/agentscaling_gpuutil.sh) (GPU util) or [`scripts/agentscaling_latency.sh`](scripts/agentscaling_latency.sh) (LLM latency). Send chats with the same [`scripts/client.sh`](scripts/client.sh). **Hermes + vLLM next:** [`scripts/test-hermes-e2e-hpa.sh`](scripts/test-hermes-e2e-hpa.sh). Run [`scripts/uninstall-e2e.sh`](scripts/uninstall-e2e.sh) first if OpenClaw sandboxes or `client.sh` are still running.

### Hermes

Matches the official [Hermes quickstart](../../../docs/get-started/quickstart-hermes.mdx)
harness (`NEMOCLAW_AGENT=hermes`, `nemohermes`, in-sandbox `hermes` / `hermes -z`).
This recipe's `AGENT_NAME` is the same string (`hermes`). The host CLI
`nemohermes launch` is **not** used here: OpenShell `0.0.85` leaves the pod idle
until `run-agent-sandbox.sh` starts the gateway. Health is `:8642/health` (not
OpenClaw's `:18789/health`). This recipe does not port-forward the Hermes dashboard.

```bash
source versions.env
export AGENT_NAME=hermes
export AGENT_SANDBOX_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:28b9578ab9676ef046de37fa6feb9b7b61824b87d77fd08978758bd01c03cb54
export INFERENCE_RUNTIME=nim
export INFERENCE_MODEL=nvidia/nemotron-3-nano
./scripts/create-agent-sandbox.sh
```

Terminal 2 — keep attached:

```bash
export AGENT_NAME=hermes
./scripts/run-agent-sandbox.sh
```

#### Simple test (no gateway, no browser)

This is the Hermes pairing check. It does not use `:8642`, a browser, or
`./scripts/verify-agent-sandbox.sh`.

```bash
export PATH="${HOME}/.local/bin:${PATH}"
openshell sandbox exec -n hermes-onprem --no-tty -- \
  hermes -z "In one sentence, what is an AI agent sandbox?" --safe-mode
```

Pass: a non-empty sentence. Do not pass `-m`. `--safe-mode` keeps a small
local model from emitting tool JSON instead of a sentence. Same oneshot as
[`docs/get-started/quickstart-hermes.mdx`](../../../docs/get-started/quickstart-hermes.mdx),
without `nemohermes launch`. Works against NIM or vLLM once `openshell inference set`
points `inference.local` at that runtime (vLLM model
`nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8`).

#### Optional full verify (needs the gateway)

`verify-agent-sandbox.sh` also waits for in-sandbox `http://localhost:8642/health`
(not a host/browser URL). Keep Terminal 2 attached first, then:

```bash
export AGENT_NAME=hermes
export INFERENCE_RUNTIME=nim
export INFERENCE_MODEL=nvidia/nemotron-3-nano
./scripts/verify-agent-sandbox.sh
```

For an already-running vLLM release, use `INFERENCE_RUNTIME=vllm` and
`INFERENCE_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8`. If start fails with
`HERMES_MCP_CONFIG_DRIFT`, rebuild the sandbox; the simple `hermes -z` test
above still proves inference.

Optional pairing test for Hermes + NIM (not required for autoscaling): [`scripts/test-hermes-nim.sh`](scripts/test-hermes-nim.sh).
Official docs also list vLLM and Ollama for Hermes; the optional NIM test exists so one example shows the NGC Secret flow.

Multi-user HPA e2e for Hermes + vLLM is the next step after OpenClaw + Ollama (`E2E_USERS=10` is only an example; `hermes -z` into each sandbox): [`scripts/test-hermes-e2e-hpa.sh`](scripts/test-hermes-e2e-hpa.sh). Run [`scripts/uninstall-e2e.sh`](scripts/uninstall-e2e.sh) first if OpenClaw sandboxes or `client.sh` are still running.

### Deep Agents Code

Matches the official
[LangChain Deep Agents Code quickstart](../../../docs/get-started/quickstart-langchain-deepagents-code.mdx)
harness (`NEMOCLAW_AGENT=langchain-deepagents-code`, `nemo-deepagents`, in-sandbox
`dcode` / `dcode -n`). This recipe's `AGENT_NAME` is the short alias **`deepagents`**,
not `langchain-deepagents-code`. There is no gateway and nothing to keep attached:
`run-agent-sandbox.sh` refuses this agent. Official NemoClaw docs cover vLLM and NIM
for Deep Agents, not Ollama. Install (or reinstall) the GPU chart with `INFERENCE_RUNTIME=vllm`
or `nim` before this loop; do not leave the chart on the Ollama default.

```bash
source versions.env
export AGENT_NAME=deepagents
export INFERENCE_RUNTIME=vllm
export INFERENCE_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8
export AGENT_SANDBOX_IMAGE=ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:f7ad7ddc95cea260cff02d26b873903805806ccfef5d27436cbec4eba3455eff
./scripts/install-hpa.sh   # skip if the release is already on this runtime and model
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh   # real headless prompt through dcode -n
./scripts/run-agent-prompt.sh "Explain this repository in one sentence."
```

Interactive TUI (TTY), equivalent to `nemo-deepagents … connect` then `dcode`:

```bash
openshell sandbox exec -n deepagents-onprem -- dcode
```

Optional pairing test (not required for autoscaling): [`scripts/test-deepagents-vllm.sh`](scripts/test-deepagents-vllm.sh).

Multi-user HPA e2e for Deep Agents + NIM is [README Quick start 6c](README.md#6c-deep-agents-code--nim-n-user-end-to-end): `agentscaling_deepagents_gpuutil.sh` / `agentscaling_deepagents_latency.sh` then `client_deepagents.sh` (`dcode -n` into each sandbox).

## Env vars

| Env var | Default | Purpose |
|---------|---------|---------|
| `AGENT_NAME` | — (required) | `openclaw`, `hermes`, or `deepagents` — selects everything else in this table |
| `AGENT_SANDBOX_IMAGE` | — (required) | Published GHCR sandbox image for the selected agent |
| `AGENT_SANDBOX_NAME` | See [Comparison](#comparison) | OpenShell sandbox name |
| `OPENSHELL_PROVIDER_NAME` | See [Comparison](#comparison) | OpenShell inference provider name |
| `AGENT_SANDBOX_CPU` / `AGENT_SANDBOX_MEMORY` | Pairing `2` / `4Gi`; OpenClaw e2e `1` / `8Gi`; Hermes and Deep Agents e2e `1` / `4Gi` | Sandbox pod requests. E2e sandboxes are light CPU front ends (inference is on GPUs). OpenClaw e2e uses 8Gi because 1Gi, 2Gi, and 4Gi OOM-kill OpenClaw at agent start. Hermes e2e uses 4Gi (`hermes -z`; 2Gi + inflight 2 OOMed dgx-19). Deep Agents e2e uses 4Gi (`dcode -n`). Size `E2E_USERS × AGENT_SANDBOX_MEMORY` to the CPU node that runs the sandboxes. |
| `NEMOCLAW_TARGET_NODE` | unset (portable) | Pin GPU inference (and, in this demo, sandboxes) to a node. Agent sandboxes can run on a different CPU node with more memory. |
| `VERIFY_HEALTH_TIMEOUT_SEC` | `90` | Plugin/version checks and OpenClaw/Hermes gateway readiness timeout |
| `VERIFY_SMOKE_TIMEOUT_SEC` | `30` | `verify-agent-sandbox.sh` timeout for the Hermes/Deep Agents Code config-file existence checks and Deep Agents Code's `dcode --version` |
| `VERIFY_CURL_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for the `/v1/models` GET (network-routing check only, all three agents) |
| `VERIFY_OPENCLAW_TIMEOUT_SEC` | `120` | Timeout for OpenClaw's real `openclaw agent --agent main -m "<prompt>"` call |
| `VERIFY_HERMES_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for Hermes's real `hermes -z "<prompt>"` call |
| `VERIFY_DCODE_TIMEOUT_SEC` | `120` | `verify-agent-sandbox.sh` timeout for Deep Agents Code's real `dcode -n "<prompt>"` call |

## Example verify output

All three agents follow the same shape: CLI/config checks, gateway health for
OpenClaw/Hermes, a `/v1/models` GET that proves the sandbox's inference route is
reachable, and finally a **real prompt through that agent's own
headless CLI** — never a curl straight to `/v1/chat/completions` — so a pass actually
proves the agent itself can answer, not just that the network path exists.

**OpenClaw**:

```text
[verify] Inspecting nemoclaw plugin (timeout 90s)...
Plugin inspect OK.
[verify] Waiting for NemoClaw/OpenClaw gateway at http://localhost:18789/health (timeout 90s)...
[verify] Gateway health OK (HTTP 200).
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: llama3.2:3b
[verify] openclaw agent --agent main -m (headless) — this is the real agent binary, not a curl probe (timeout 120s)
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox nemoclaw-onprem reached https://inference.local for models and answered a real prompt through NemoClaw/OpenClaw (llama3.2:3b).
Runtime: NemoClaw/OpenClaw gateway is healthy; keep run-agent-sandbox.sh attached.
```

**Hermes**:

```text
[verify] Checking hermes --version (timeout 90s)...
hermes --version OK.
[verify] Checking config.yaml was generated (timeout 30s)...
config.yaml OK.
[verify] Waiting for NemoClaw/Hermes gateway at http://localhost:8642/health (timeout 90s)...
[verify] Gateway health OK (HTTP 200).
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: nvidia/nemotron-3-nano
[verify] hermes -z (headless) — this is the real agent binary, not a curl probe (timeout 120s)
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox hermes-onprem reached https://inference.local for models and answered a real prompt through NemoClaw/Hermes (nvidia/nemotron-3-nano).
Runtime: NemoClaw/Hermes gateway is healthy; keep run-agent-sandbox.sh attached.
```

**Deep Agents Code** (terminal harness — no health probe, real `dcode -n` call instead):

```text
[verify] Checking dcode --version (timeout 30s)...
dcode --version OK.
[verify] Checking config.toml was generated (timeout 30s)...
config.toml OK.
[verify] GET https://inference.local/v1/models (timeout 120s)...
models: nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8
[verify] dcode -n (headless) — this is the real agent binary, not a curl probe (timeout 120s)
[verify] Example query: In one sentence, what is an AI agent sandbox?
[verify] Answer: An AI agent sandbox is a simulated environment where an AI agent
can interact and learn in a safe, controlled space.
OK: sandbox deepagents-onprem reached https://inference.local for models and answered a real prompt through NemoClaw/Deep Agents Code (nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8).
NemoClaw/Deep Agents Code has no long-running gateway; run one-shot prompts with:
  AGENT_NAME=deepagents ./scripts/run-agent-prompt.sh "your prompt here"
```

<a id="shared-policy-notes"></a>

## Sandbox policies

- Each agent uses its official NemoClaw OpenShell policy.
- This on-premises recipe removes the default `integrate.api.nvidia.com` access from
  the OpenClaw and Hermes policies.
- The Deep Agents Code policy does not grant access to that endpoint.

## Notes

- `verify-agent-sandbox.sh` runs a real prompt through each agent's own headless CLI —
  `openclaw agent --agent main -m "<prompt>"`,
  `hermes -z "<prompt>"`, or `dcode -n "<prompt>"` — never a curl straight to
  `https://inference.local/v1/chat/completions`. The earlier `/v1/models` GET already
  proves network reachability; verification also rejects all known OpenClaw
  embedded-fallback markers so a broken gateway cannot produce a false pass.
- Hermes forwards two ports inside the sandbox per its manifest: the dashboard on `18789`
  and the OpenAI-compatible API on `8642`. Neither is exposed by `create-agent-sandbox.sh`
  today — reaching the
  dashboard from outside the sandbox would need its own `kubectl port-forward` to the
  sandbox pod, which this recipe has not set up or validated. `create-agent-sandbox.sh`
  checks the generated config while the sandbox is idle. Start `run-agent-sandbox.sh`
  before verification; verification then requires the `:8642/health` endpoint.
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
- Official NemoClaw local providers for Deep Agents Code are vLLM and NIM, not Ollama.
  This recipe does not document `AGENT_NAME=deepagents` with `INFERENCE_RUNTIME=ollama`.
  `agent_common_validate_runtime_pairing` refuses that pairing in the optional
  pairing tests, `install-hpa.sh` (when `AGENT_NAME` is set), and the sandbox
  build/create/verify/prompt scripts.
