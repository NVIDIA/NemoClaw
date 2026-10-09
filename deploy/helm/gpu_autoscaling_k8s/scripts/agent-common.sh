#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Per-agent configuration for the generic build/create/verify/run-agent-*.sh scripts.
# Adding a fourth agent means extending the case statements below — not adding new script
# files. See ../AGENT-SELECTION.md for the agent comparison and shared policy notes.

agent_common_validate() {
  case "${1:-}" in
    openclaw | hermes | deepagents) ;;
    *)
      echo "ERROR: AGENT_NAME must be openclaw, hermes, or deepagents (got '${1:-}')" >&2
      exit 1
      ;;
  esac
}

# Laptop clients talk HTTP to dgx-ip (published host ports). See
# ../README.md#how-clients-work-6a--6b--6c
agent_common_print_laptop_client_usage() {
  local script_name="${1:?client script}"
  echo "Default — any remote machine: E2E_CLIENT_HOST=dgx-ip E2E_USERS=${E2E_USERS:-5} ./scripts/${script_name}"
  echo "simpler option — from the same DGX in another terminal: E2E_USERS=${E2E_USERS:-5} ./scripts/${script_name}"
}

# Same client for both HPA metrics. GPU util does not take MAX_TOKENS
# (OpenClaw 4096, Hermes 1024, Deep Agents 2048). Latency uses MAX_TOKENS
# (default 64). OpenClaw GPU util uses three in-flight chats on the one
# agent per sandbox so 1→8 stays above the HPA target; latency stays inflight 1.
# The client holds ~60s at 8 GPUs, then stops.
agent_common_hpa_metric() {
  local metric="${HPA_METRIC:-}"
  if [[ -z "${metric}" ]] && command -v kubectl >/dev/null 2>&1; then
    metric="$(kubectl get hpa "${HPA_NAME:-nemoclaw-gpu-metrics-proxy}" \
      -n "${NAMESPACE:-nemoclaw-gpu}" \
      -o jsonpath='{.spec.metrics[0].pods.metric.name}' 2>/dev/null || true)"
  fi
  if [[ -z "${metric}" && -n "${E2E_CLIENT_HOST:-}" ]] && command -v python3 >/dev/null 2>&1; then
    metric="$(python3 -c '
import json, sys, urllib.request
host, port = sys.argv[1], sys.argv[2]
try:
    with urllib.request.urlopen("http://%s:%s/hpa" % (host, port), timeout=3) as resp:
        data = json.loads(resp.read().decode())
    if isinstance(data, dict):
        print(str(data.get("metric") or ""))
except Exception:
    pass
' "${E2E_CLIENT_HOST}" "${E2E_DISCOVERY_PORT:-18788}" 2>/dev/null || true)"
  fi
  printf '%s\n' "${metric}"
}

agent_common_resolve_max_tokens() {
  local agent="${1:-openclaw}"
  local raw=""
  local metric
  metric="$(agent_common_hpa_metric)"
  case "${metric}" in
    *latency*)
      raw="${MAX_TOKENS:-${E2E_LATENCY_TOKEN_START:-64}}"
      ;;
    "")
      if [[ -n "${MAX_TOKENS:-}" ]]; then
        raw="${MAX_TOKENS}"
      else
        case "${agent}" in
          openclaw) raw="${E2E_GPUUTIL_TOKEN_START:-4096}" ;;
          deepagents) raw="${E2E_GPUUTIL_TOKEN_START:-2048}" ;;
          *) raw="${E2E_GPUUTIL_TOKEN_START:-1024}" ;;
        esac
      fi
      ;;
    *)
      case "${agent}" in
        openclaw) raw="${E2E_GPUUTIL_TOKEN_START:-4096}" ;;
        deepagents) raw="${E2E_GPUUTIL_TOKEN_START:-2048}" ;;
        *) raw="${E2E_GPUUTIL_TOKEN_START:-1024}" ;;
      esac
      ;;
  esac
  [[ "${raw}" =~ ^[1-9][0-9]*$ ]] || {
    echo "ERROR: MAX_TOKENS must be a positive integer (got '${raw}')" >&2
    return 1
  }
  if ((raw < 8)); then
    raw=8
  fi
  printf '%s\n' "${raw}"
}

# One-time client pin. GPU util ignores a leftover MAX_TOKENS in the shell.
agent_common_export_client_tokens() {
  local agent="${1:-openclaw}"
  local metric
  metric="$(agent_common_hpa_metric)"
  MAX_TOKENS="$(agent_common_resolve_max_tokens "${agent}")"
  export MAX_TOKENS
  case "${metric}" in
    *latency* | "") ;;
    *) export E2E_GPUUTIL_TOKEN_START="${MAX_TOKENS}" ;;
  esac
}

# One agent per sandbox. OpenClaw GPU util needs three in-flight chats:
# five inflight-1 chats stall at 7 GPUs (~40%/40). Four chats hung the
# gateway. Do not copy extra helpers into the sandbox to finish 7→8.
agent_common_export_client_inflight() {
  local agent="${1:-openclaw}"
  local metric
  metric="$(agent_common_hpa_metric)"
  case "${metric}" in
    *latency*)
      export E2E_INFLIGHT_START_PER_USER=1
      export E2E_INFLIGHT_PER_USER=1
      ;;
    *)
      if [[ "${agent}" == "openclaw" ]]; then
        local gpu_n="${E2E_GPUUTIL_INFLIGHT_MAX:-3}"
        export E2E_INFLIGHT_START_PER_USER="${gpu_n}"
        export E2E_INFLIGHT_PER_USER="${gpu_n}"
        export E2E_GPUUTIL_INFLIGHT_MAX="${gpu_n}"
        export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-120}"
      else
        export E2E_INFLIGHT_START_PER_USER=1
        export E2E_INFLIGHT_PER_USER=1
      fi
      ;;
  esac
}

agent_common_print_load_banner() {
  local duration="${1:?}"
  local hold="${2:?}"
  local metric
  metric="$(agent_common_hpa_metric)"
  case "${metric}" in
    *latency*)
      echo "Sends chats for ${duration}s. Latency MAX_TOKENS=${MAX_TOKENS}. Holds ${hold}s at 8 GPUs, then stops."
      ;;
    *)
      echo "Sends chats for ${duration}s. GPU util does not take MAX_TOKENS (built-in ${MAX_TOKENS}), inflight=${E2E_INFLIGHT_PER_USER:-1}. Holds ${hold}s at 8 GPUs, then stops."
      ;;
  esac
}

agent_common_fail_openshell_for_client() {
  echo "ERROR: $*. From a laptop use HTTP, not SSH:" >&2
  echo "  E2E_CLIENT_HOST=dgx-ip E2E_USERS=${E2E_USERS:-5} ./scripts/client.sh" >&2
  exit 1
}

# Silent 2s UTC JSONL animation logs. Client writes client-timeline.jsonl.
# Provision writes hpa-timeline.jsonl. Join both files on the ts column.
agent_common_e2e_output_dir() {
  local agent="${1:-openclaw}"
  case "${agent}" in
    hermes) printf '%s' "${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/hermes}" ;;
    deepagents) printf '%s' "${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/deepagents}" ;;
    *) printf '%s' "${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama}" ;;
  esac
}

agent_common_stop_hpa_timeline() {
  local dir="${1:?output dir}"
  local pidfile="${dir}/hpa-timeline.pid"
  local pid=""
  if [[ -f "${pidfile}" ]]; then
    pid="$(cat "${pidfile}" 2>/dev/null || true)"
    rm -f "${pidfile}"
  fi
  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
  fi
}

agent_common_start_hpa_timeline() {
  local dir="${1:?output dir}"
  local truncate="${2:-0}"
  local here pidfile pid
  local -a extra=()
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  command -v kubectl >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  mkdir -p "${dir}"
  pidfile="${dir}/hpa-timeline.pid"
  if [[ -f "${pidfile}" ]]; then
    pid="$(cat "${pidfile}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      return 0
    fi
    rm -f "${pidfile}"
  fi
  if [[ "${truncate}" == "1" ]]; then
    extra+=(--truncate)
  fi
  nohup python3 "${here}/e2e-hpa-timeline.py" \
    --output "${dir}/hpa-timeline.jsonl" \
    --namespace "${NAMESPACE:-nemoclaw-gpu}" \
    --hpa-name "${HPA_NAME:-nemoclaw-gpu-metrics-proxy}" \
    "${extra[@]}" >/dev/null 2>&1 &
  echo $! >"${pidfile}"
}

# Local-runtime ids this recipe's Helm chart can render (ollama | vllm | nim).
# Which pairings are documented for each agent is official NemoClaw guidance —
# see ../README.md#6-e2e-test-with-multiple-end-users-and-sandboxes and
# ../../../docs/inference/choose-inference-provider.mdx.
agent_common_validate_inference_runtime() {
  case "${1:-}" in
    ollama | vllm | nim) ;;
    *)
      echo "ERROR: INFERENCE_RUNTIME must be ollama, vllm, or nim (got '${1:-}')" >&2
      exit 1
      ;;
  esac
}

# Wrapper defaults (6a/6b/6c). Override with INFERENCE_RUNTIME=ollama|vllm|nim.
agent_common_default_inference_runtime() {
  case "${1:-}" in
    hermes) printf '%s' "vllm" ;;
    deepagents) printf '%s' "nim" ;;
    *) printf '%s' "ollama" ;;
  esac
}

# Official docs prefer 6a/6b/6c. Any ollama|vllm|nim override is allowed.
agent_common_validate_runtime_pairing() {
  local agent="${1:?agent}"
  local runtime="${2:-}"
  agent_common_validate "${agent}"
  if [[ -n "${runtime}" ]]; then
    agent_common_validate_inference_runtime "${runtime}"
  fi
  if [[ "${agent}" == "deepagents" && ( -z "${runtime}" || "${runtime}" == "ollama" ) ]]; then
    echo "WARNING: documented Deep Agents default is nim (or vllm). Using ${runtime:-ollama} because INFERENCE_RUNTIME overrides." >&2
  fi
}

# E2E defaults by inference runtime (Quick start 6a/6b/6c).
agent_common_default_inference_model() {
  case "${1:-ollama}" in
    vllm) printf '%s' "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8" ;;
    nim) printf '%s' "nvidia/nemotron-3-nano" ;;
    *) printf '%s' "llama3.2:3b" ;;
  esac
}

# Pick INFERENCE_MODEL for a runtime. Uses that runtime's default when unset
# or when the value is another pairing's leftover default (same shell after 6a/6b).
# Any other value is kept as an explicit override.
agent_common_resolve_inference_model() {
  local runtime="${1:?runtime}"
  local current="${INFERENCE_MODEL:-}"
  local want ollama_default vllm_default nim_default
  want="$(agent_common_default_inference_model "${runtime}")"
  ollama_default="$(agent_common_default_inference_model ollama)"
  vllm_default="$(agent_common_default_inference_model vllm)"
  nim_default="$(agent_common_default_inference_model nim)"
  case "${current}" in
    ""|"${ollama_default}"|"${vllm_default}"|"${nim_default}")
      if [[ -z "${current}" || \
            ("${current}" == "${ollama_default}" && "${runtime}" != "ollama") || \
            ("${current}" == "${vllm_default}" && "${runtime}" != "vllm") || \
            ("${current}" == "${nim_default}" && "${runtime}" != "nim") ]]; then
        printf '%s' "${want}"
        return 0
      fi
      ;;
  esac
  printf '%s' "${current}"
}

# Published GHCR digests used by Quick start 6a/6b/6c e2e scripts.
agent_common_default_sandbox_image() {
  case "${1:-}" in
    hermes) printf '%s' "ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:28b9578ab9676ef046de37fa6feb9b7b61824b87d77fd08978758bd01c03cb54" ;;
    deepagents) printf '%s' "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox@sha256:f7ad7ddc95cea260cff02d26b873903805806ccfef5d27436cbec4eba3455eff" ;;
    *) printf '%s' "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:bd935f0198b99889d9479fea123b62a59e3797da13e392dcc2160f114216c1ba" ;;
  esac
}

# Which official agent repo an image string belongs to, if any.
# Deep Agents is langchain-deepagents-code-sandbox, never hermes-sandbox.
agent_common_sandbox_image_owner() {
  case "${1:-}" in
    *langchain-deepagents* | *nemoclaw-deepagents*) printf '%s' deepagents ;;
    *hermes-sandbox* | *nemoclaw-hermes*) printf '%s' hermes ;;
    *openclaw-sandbox* | *nemoclaw-openclaw*) printf '%s' openclaw ;;
  esac
}

# Use this agent's published image when AGENT_SANDBOX_IMAGE is unset or is
# another pairing's leftover (Hermes/OpenClaw image in a Deep Agents shell).
# A custom image is kept only if it does not look like a different agent.
agent_common_resolve_sandbox_image() {
  local agent="${1:?agent}"
  local current="${AGENT_SANDBOX_IMAGE:-}"
  local want owner
  want="$(agent_common_default_sandbox_image "${agent}")"
  if [[ -z "${current}" ]]; then
    printf '%s' "${want}"
    return 0
  fi
  owner="$(agent_common_sandbox_image_owner "${current}")"
  if [[ -n "${owner}" && "${owner}" != "${agent}" ]]; then
    printf '%s' "${want}"
    return 0
  fi
  printf '%s' "${current}"
}

agent_common_require_sandbox_image_for_agent() {
  local agent="${1:?agent}"
  local image="${2:?image}"
  local owner
  owner="$(agent_common_sandbox_image_owner "${image}")"
  if [[ -n "${owner}" && "${owner}" != "${agent}" ]]; then
    echo "ERROR: AGENT_NAME=${agent} cannot use ${owner} image ${image}" >&2
    exit 1
  fi
}

# README Quick start 6a/6b/6c pairings. TAB-separated: agent runtime model
agent_common_example_pairings() {
  printf '%s\t%s\t%s\n' \
    openclaw ollama llama3.2:3b \
    hermes vllm nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8 \
    deepagents nim nvidia/nemotron-3-nano
}

# Optional pairing-test script for that agent's documented example pairing.
agent_common_example_script() {
  printf 'test-%s-%s.sh' "${1:?agent}" "${2:?runtime}"
}

agent_common_is_example_pairing() {
  local agent="${1:?agent}" runtime="${2:?runtime}" a r
  while IFS=$'\t' read -r a r _; do
    if [[ "${a}" == "${agent}" && "${r}" == "${runtime}" ]]; then
      return 0
    fi
  done < <(agent_common_example_pairings)
  return 1
}

agent_common_example_model() {
  local agent="${1:?agent}" runtime="${2:?runtime}" a r m
  while IFS=$'\t' read -r a r m; do
    if [[ "${a}" == "${agent}" && "${r}" == "${runtime}" ]]; then
      printf '%s' "${m}"
      return 0
    fi
  done < <(agent_common_example_pairings)
  return 1
}

# Pin AGENT_NAME / INFERENCE_RUNTIME / INFERENCE_MODEL to one README example.
agent_common_pin_example_pairing() {
  local agent="${1:?agent}" runtime="${2:?runtime}" model
  model="$(agent_common_example_model "${agent}" "${runtime}")" || {
    echo "ERROR: ${agent}+${runtime} is not a README example pairing." >&2
    exit 1
  }
  if [[ -n "${AGENT_NAME:-}" && "${AGENT_NAME}" != "${agent}" ]]; then
    echo "ERROR: AGENT_NAME=${AGENT_NAME} does not match this pairing (${agent})." >&2
    exit 1
  fi
  if [[ -n "${INFERENCE_RUNTIME:-}" && "${INFERENCE_RUNTIME}" != "${runtime}" ]]; then
    echo "ERROR: INFERENCE_RUNTIME=${INFERENCE_RUNTIME} does not match this script (${runtime}). This script only runs ${agent}+${runtime}." >&2
    exit 1
  fi
  export AGENT_NAME="${agent}"
  export INFERENCE_RUNTIME="${runtime}"
  export INFERENCE_MODEL="${INFERENCE_MODEL:-${model}}"
  agent_common_validate_runtime_pairing "${AGENT_NAME}" "${INFERENCE_RUNTIME}"
}

agent_common_display_name() {
  case "$1" in
    openclaw) echo "NemoClaw/OpenClaw" ;;
    hermes) echo "NemoClaw/Hermes" ;;
    deepagents) echo "NemoClaw/Deep Agents Code" ;;
  esac
}

agent_common_default_sandbox_name() {
  case "$1" in
    openclaw) echo "nemoclaw-onprem" ;;
    hermes) echo "hermes-onprem" ;;
    deepagents) echo "deepagents-onprem" ;;
  esac
}

agent_common_default_provider_name() {
  case "$1" in
    openclaw) echo "onprem-ollama" ;;
    hermes) echo "onprem-hermes" ;;
    deepagents) echo "onprem-deepagents" ;;
  esac
}

# Relative to the cloned NemoClaw source root.
agent_common_dockerfile_rel_path() {
  case "$1" in
    openclaw) echo "Dockerfile" ;;
    hermes) echo "agents/hermes/Dockerfile" ;;
    deepagents) echo "agents/langchain-deepagents-code/Dockerfile" ;;
  esac
}

agent_common_base_image_repo() {
  case "$1" in
    openclaw) echo "ghcr.io/nvidia/nemoclaw/sandbox-base" ;;
    hermes) echo "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base" ;;
    deepagents) echo "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base" ;;
  esac
}

# Relative to the cloned NemoClaw source root. Despite the hermes/deepagents filename
# ("policy-additions.yaml"), all three are complete, self-contained OpenShell policies —
# not deltas merged onto another file.
agent_common_policy_rel_path() {
  case "$1" in
    openclaw) echo "nemoclaw-blueprint/policies/openclaw-sandbox.yaml" ;;
    hermes) echo "agents/hermes/policy-additions.yaml" ;;
    deepagents) echo "agents/langchain-deepagents-code/policy-additions.yaml" ;;
  esac
}

# gateway = long-running entrypoint kept alive by run-agent-sandbox.sh.
# terminal = no entrypoint to keep running; use run-agent-prompt.sh instead.
agent_common_run_mode() {
  case "$1" in
    openclaw | hermes) echo "gateway" ;;
    deepagents) echo "terminal" ;;
  esac
}

# Loopback health endpoint exposed by each long-running agent gateway.
agent_common_gateway_health_url() {
  case "$1" in
    openclaw) echo "http://localhost:18789/health" ;;
    hermes) echo "http://localhost:8642/health" ;;
    deepagents) return 1 ;;
  esac
}

# OpenClaw can exit successfully after degrading to an embedded runtime when its
# gateway is unavailable. Treat every upstream marker as a verification failure.
agent_common_output_has_embedded_fallback() {
  local output="${1:-}"
  grep -Eqi 'EMBEDDED FALLBACK|\[agent/embedded\]|fallbackFrom[": ]+gateway|transport[": ]+embedded' \
    <<<"${output}"
}

# True (exit 0) if this agent's upstream policy grants integrate.api.nvidia.com and
# create-agent-sandbox.sh must remove it, since this recipe is on-premises-only.
agent_common_grants_nvidia_endpoint() {
  case "$1" in
    openclaw | hermes) return 0 ;;
    deepagents) return 1 ;;
  esac
}

# Extra docker buildx --build-arg values beyond the shared set, one per line.
agent_common_extra_build_args() {
  local agent="${1:?agent}" model="${2:?model}"
  case "${agent}" in
    openclaw) printf '%s\n' "NEMOCLAW_PRIMARY_MODEL_REF=inference/${model}" ;;
    hermes | deepagents) ;;
  esac
}

# In-sandbox GET of https://inference.local/v1/models.
# Hermes managed_inference allows python3, not curl (curl would inherit injected credentials).
# Usage: openshell sandbox exec -n NAME --no-tty -- python3 -c "${AGENT_COMMON_INFERENCE_MODELS_PY}" [timeout]
AGENT_COMMON_INFERENCE_MODELS_PY='import urllib.request,sys; t=float(sys.argv[1]) if len(sys.argv)>1 else 5.0; print(urllib.request.urlopen("https://inference.local/v1/models", timeout=t).read().decode())'

# Fast smoke test run immediately after `openshell sandbox create` in
# create-agent-sandbox.sh. No retries/timeouts here — hpa_common_verify_target_node /
# openshell already waited for the sandbox to be Ready; verify-agent-sandbox.sh is the
# place for timeout-guarded, logged checks.
agent_common_create_smoke_test() {
  local agent="${1:?agent}" sandbox_name="${2:?sandbox_name}"
  case "${agent}" in
    openclaw)
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        openclaw plugins inspect nemoclaw --json >/dev/null
      ;;
    hermes)
      # NOT a gateway health probe: OpenShell keeps sandboxes idle (`sleep infinity`)
      # until run-agent-sandbox.sh execs nemoclaw-start in the foreground, so nothing
      # listens on Hermes's gateway port (8642) yet at this point. Mirror the deepagents
      # check below instead — confirm the build-time-generated config is present.
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        hermes --version >/dev/null
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        bash -c 'test -s /sandbox/.hermes/config.yaml && echo NEMOCLAW_HERMES_CONFIG_OK' >/dev/null
      ;;
    deepagents)
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        dcode --version >/dev/null
      openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
        bash -c 'test -s /sandbox/.deepagents/config.toml && echo NEMOCLAW_DEEPAGENTS_CONFIG_OK' >/dev/null
      ;;
  esac
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    python3 -c "${AGENT_COMMON_INFERENCE_MODELS_PY}" 5 >/dev/null
}

# GHCR Hermes images bake NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b.
# Point oneshot at the chart model so hermes -z does not send a missing id.
agent_common_pin_hermes_model() {
  local sandbox_name="${1:?sandbox}" model="${2:?model}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    hermes config set model.default "${model}" >/dev/null
}

agent_common_pin_hermes_max_tokens() {
  local sandbox_name="${1:?sandbox}"
  local max_tokens="${2:-${MAX_TOKENS:-2048}}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    hermes config set model.max_tokens "${max_tokens}" >/dev/null
}

# GHCR Deep Agents images bake NEMOCLAW_MODEL=nvidia/nemotron-3-ultra-550b-a55b.
# Point dcode -n at the chart NIM model and drop leftover openai.params for
# that baked id (Deep Agents errors if params name a model not in models[]).
# max_tokens is a ChatOpenAI constructor kwarg on the live GHCR image
# ([models.providers.openai.params] flat keys). Default 2048 so one
# dcode -n per sandbox keeps NIM busy enough for GPU-util HPA to 8.
agent_common_pin_deepagents_model() {
  local sandbox_name="${1:?sandbox}" model="${2:?model}"
  local max_tokens="${3:-${MAX_TOKENS:-2048}}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    env -u VIRTUAL_ENV PIN_MODEL="${model}" PIN_MAX_TOKENS="${max_tokens}" python3 -c '
import os, pathlib, re
model = os.environ["PIN_MODEL"].removeprefix("openai:")
max_tokens = int(os.environ["PIN_MAX_TOKENS"])
if max_tokens < 8:
    raise SystemExit("PIN_MAX_TOKENS must be >= 8")
path = pathlib.Path("/sandbox/.deepagents/config.toml")
text = path.read_text()
text, n = re.subn(r"(?m)^default = \".*\"$", "default = \"openai:" + model + "\"", text, count=1)
if n != 1:
    raise SystemExit("failed to set models.default")
text, n = re.subn(r"(?m)^models = \[.*\]$", "models = [\"" + model + "\"]", text, count=1)
if n != 1:
    raise SystemExit("failed to set provider models")
kept = []
for chunk in re.split(r"(?m)(?=^\[)", text):
    match = re.match(r"^\[models\.providers\.openai\.params\.\"([^\"]+)\"\]", chunk)
    if match and match.group(1) != model:
        continue
    kept.append(chunk)
text = "".join(kept)
if "[models.providers.openai.params.\"nvidia/nemotron-3-ultra-550b-a55b\"]" in text:
    raise SystemExit("leftover ultra-550b params still present")
if re.search(r"(?m)^max_tokens = \d+$", text):
    text, n = re.subn(r"(?m)^max_tokens = \d+$", "max_tokens = " + str(max_tokens), text, count=1)
else:
    text, n = re.subn(
        r"(?m)^use_responses_api = false$",
        "use_responses_api = false\nmax_tokens = " + str(max_tokens),
        text,
        count=1,
    )
if n != 1:
    raise SystemExit("failed to set max_tokens")
path.write_text(text)
print("NEMOCLAW_DEEPAGENTS_MODEL_OK")
' >/dev/null
}

# Client path: keep the provisioned OpenClaw model; pin max_tokens once.
agent_common_pin_openclaw_max_tokens() {
  local sandbox_name="${1:?sandbox}"
  local max_tokens="${2:-${MAX_TOKENS:-2048}}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    env HOME=/sandbox PIN_MAX_TOKENS="${max_tokens}" python3 -c '
import json, os, pathlib, subprocess
max_tokens = int(os.environ["PIN_MAX_TOKENS"])
if max_tokens < 8:
    raise SystemExit("PIN_MAX_TOKENS must be >= 8")
path = pathlib.Path("/sandbox/.openclaw/openclaw.json")
cfg = json.loads(path.read_text())
provider = ((cfg.get("models") or {}).get("providers") or {}).get("inference") or {}
models = provider.get("models")
if not isinstance(models, list) or not models or not isinstance(models[0], dict):
    raise SystemExit("missing inference model entry")
params = models[0].get("params")
if not isinstance(params, dict):
    params = {}
    models[0]["params"] = params
params["max_tokens"] = max_tokens
params["num_predict"] = max_tokens
options = params.get("options")
if not isinstance(options, dict):
    options = {}
    params["options"] = options
options["num_predict"] = max_tokens
if max_tokens > 128:
    params["ignore_eos"] = True
    options["ignore_eos"] = True
else:
    params.pop("ignore_eos", None)
    options.pop("ignore_eos", None)
models[0]["maxTokens"] = max_tokens
tools = cfg.setdefault("tools", {})
deny = tools.get("deny")
if not isinstance(deny, list):
    deny = []
for name in ("message", "cron", "gateway", "nodes", "sessions_send", "exec", "process", "bash"):
    if name not in deny:
        deny.append(name)
tools["deny"] = deny
text = json.dumps(cfg, indent=2) + "\n"
path.write_text(text)
for name in (
    "openclaw.json.bak",
    "openclaw.json.last-good",
    "openclaw.json.nemoclaw-baseline",
):
    snap = path.with_name(name)
    try:
        snap.write_text(text)
    except OSError:
        pass  # Snapshot is optional; the live openclaw.json is already written.
print("NEMOCLAW_OPENCLAW_MAX_TOKENS_OK")
batch = pathlib.Path("/tmp/nemoclaw-openclaw-max-tokens-set.json")
batch.write_text(json.dumps([{"path": "models.providers.inference", "value": provider}]) + "\n")
try:
    subprocess.run(
        ["openclaw", "config", "set", "--batch-file", str(batch)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
except subprocess.TimeoutExpired:
    pass  # File pin already landed; SIGHUP reload still applies it.
' >/dev/null
  # File watch is off (gateway.reload=off). Hermes applies max_tokens live via
  # `hermes config set`. SIGHUP is not enough for OpenClaw: client.sh stops
  # and starts the gateway after every pin so the new max_tokens is live.
  agent_common_reload_openclaw_gateway "${sandbox_name}"
}

agent_common_reload_openclaw_gateway() {
  local sandbox_name="${1:?sandbox}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    bash -c 'pkill -HUP -f "[o]penclaw gateway run" || true' >/dev/null || true
}

# After pin+reload, wait until every published :18789+i answers again.
agent_common_wait_published_openclaw_health() {
  local users="${1:?}"
  local timeout_sec="${2:-90}"
  local start port code i unhealthy now
  start="$(date +%s)"
  while true; do
    unhealthy=0
    for ((i = 0; i < users; i += 1)); do
      port=$((18789 + i))
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
      case "${code}" in
        200 | 401) ;;
        *) unhealthy=1 ;;
      esac
    done
    if ((unhealthy == 0)); then
      return 0
    fi
    now="$(date +%s)"
    if ((now - start >= timeout_sec)); then
      echo "ERROR: OpenClaw :18789+i did not recover after max_tokens pin" >&2
      return 1
    fi
    sleep 2
  done
}

# Client path: keep the provisioned model.default; only raise max_tokens.
agent_common_pin_deepagents_max_tokens() {
  local sandbox_name="${1:?sandbox}"
  local max_tokens="${2:-${MAX_TOKENS:-2048}}"
  openshell sandbox exec -n "${sandbox_name}" --no-tty -- \
    env -u VIRTUAL_ENV PIN_MAX_TOKENS="${max_tokens}" python3 -c '
import os, pathlib, re
max_tokens = int(os.environ["PIN_MAX_TOKENS"])
if max_tokens < 8:
    raise SystemExit("PIN_MAX_TOKENS must be >= 8")
path = pathlib.Path("/sandbox/.deepagents/config.toml")
text = path.read_text()
if re.search(r"(?m)^max_tokens = \d+$", text):
    text, n = re.subn(r"(?m)^max_tokens = \d+$", "max_tokens = " + str(max_tokens), text, count=1)
else:
    text, n = re.subn(
        r"(?m)^use_responses_api = false$",
        "use_responses_api = false\nmax_tokens = " + str(max_tokens),
        text,
        count=1,
    )
if n != 1:
    raise SystemExit("failed to set max_tokens")
path.write_text(text)
print("NEMOCLAW_DEEPAGENTS_MAX_TOKENS_OK")
' >/dev/null
}
