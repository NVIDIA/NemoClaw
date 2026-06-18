#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# VDA preflight checks:
#   - requires HF secret for model cache downloads
#   - supports optional NGC key discovery/refresh for nvcr_io credential maintenance
#   - optional outbound probes (workflow image registry access + NGC REST + HF)
#   - ensures required OSMO credentials exist (hf_token always; nvcr_io only when key provided)
#   - creates missing credentials from env vars; refreshes existing credentials when
#     --refresh is set or new env key material is supplied
# NOTE:
#   This script does NOT validate credentials for external VLM/LLM endpoints.
#   Endpoint API keys/tokens must be validated separately per endpoint.
#
# Usage:
#   preflight_credentials.sh [--no-probe] [--workflow <workflow-yaml>] [--refresh|--overwrite]
#
# Exit 0 when all checks pass, else exit 1 with remediation.

set -euo pipefail

usage() {
  echo "usage: $0 [--no-probe] [--workflow <workflow-yaml>] [--refresh|--overwrite]" >&2
  exit 2
}

probe=true
workflow_file=""
registry_probe_checked=false
refresh_credentials=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-probe)
      probe=false
      shift
      ;;
    --workflow)
      [[ $# -ge 2 ]] || usage
      workflow_file="$2"
      shift 2
      ;;
    --workflow=*)
      workflow_file="${1#--workflow=}"
      shift
      ;;
    --refresh|--overwrite)
      refresh_credentials=true
      shift
      ;;
    *)
      usage
      ;;
  esac
done

if [ -n "${workflow_file}" ] && [ ! -f "${workflow_file}" ]; then
  echo "workflow file not found: ${workflow_file}" >&2
  usage
fi

user_supplied_ngc_key=false
for var_name in NGC_API_KEY NGC_CLI_API_KEY NVIDIA_API_KEY OPENAI_API_KEY VLM_API_KEY LLM_API_KEY; do
  if [[ -n "${!var_name:-}" ]]; then
    user_supplied_ngc_key=true
    break
  fi
done

user_supplied_hf_token=false
for var_name in HF_TOKEN HUGGING_FACE_HUB_TOKEN; do
  if [[ -n "${!var_name:-}" ]]; then
    user_supplied_hf_token=true
    break
  fi
done

emit_user_input_required() {
  local msg="${1:-Missing required user input.}"
  echo "USER_INPUT_REQUIRED: ${msg}" >&2
}

ngc_config_file="${NGC_CONFIG_FILE:-${HOME}/.ngc/config}"

resolve_ngc_scope_value() {
  local key="$1"
  local env_value=""
  if [ "$key" = "org" ]; then
    env_value="${NGC_ORG:-${NGC_CLI_ORG:-}}"
  else
    env_value="${NGC_TEAM:-${NGC_CLI_TEAM:-}}"
  fi
  if [ -n "${env_value}" ]; then
    printf '%s' "${env_value}"
    return 0
  fi
  if [ -f "${ngc_config_file}" ]; then
    awk -F '=' -v k="$key" '
      BEGIN{in_current=0}
      /^\[CURRENT\]/ {in_current=1; next}
      /^\[/ && $0 !~ /^\[CURRENT\]/ {if(in_current) exit}
      in_current && $1 ~ "^[[:space:]]*" k "[[:space:]]*$" {
        v=$2
        sub(/^[[:space:]]+/, "", v)
        sub(/[[:space:]]+$/, "", v)
        print v
        exit
      }
    ' "${ngc_config_file}"
  fi
  return 0
}

resolve_ngc_api_key() {
  local candidate=""
  local var_name=""

  # Preferred path: reuse any existing nvapi* token first, regardless of env var name.
  for var_name in NGC_API_KEY NGC_CLI_API_KEY NVIDIA_API_KEY OPENAI_API_KEY VLM_API_KEY LLM_API_KEY; do
    candidate="${!var_name:-}"
    case "${candidate}" in
      "Authorization: Bearer "*) candidate="${candidate#Authorization: Bearer }" ;;
      "Bearer "*) candidate="${candidate#Bearer }" ;;
    esac
    if [[ "${candidate}" =~ ^[Nn][Vv][Aa][Pp][Ii]- ]]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done

  # Fallback: accept any key from NGC-specific env vars.
  # (nvapi* tokens are already preferred by the loop above.)
  for var_name in NGC_API_KEY NGC_CLI_API_KEY; do
    candidate="${!var_name:-}"
    case "${candidate}" in
      "Authorization: Bearer "*) candidate="${candidate#Authorization: Bearer }" ;;
      "Bearer "*) candidate="${candidate#Bearer }" ;;
    esac
    if [ -n "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done

  return 0
}

resolve_hf_token() {
  local env_value="${HF_TOKEN:-${HUGGING_FACE_HUB_TOKEN:-}}"
  local discovered=""
  local token_file="${HF_TOKEN_FILE:-${HOME}/.cache/huggingface/token}"
  if [ -n "${env_value}" ]; then
    printf '%s' "${env_value}"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    discovered="$(python3 - <<'PY'
try:
    from huggingface_hub import get_token
    t = get_token() or ""
    print(t)
except Exception:
    pass
PY
)"
    if [ -n "${discovered}" ]; then
      printf '%s' "${discovered}"
      return 0
    fi
  fi
  if [ -f "${token_file}" ]; then
    local first_line=""
    if IFS= read -r first_line < "${token_file}"; then
      printf '%s' "${first_line}"
    fi
  fi
  return 0
}

extract_workflow_nvcr_images() {
  local workflow="$1"
  awk '
    /^[[:space:]]*image:[[:space:]]*/ {
      line=$0
      sub(/^[[:space:]]*image:[[:space:]]*/, "", line)
      sub(/[[:space:]]+#.*/, "", line)
      gsub(/["'"'"'"]/, "", line)
      if (line ~ /^nvcr\.io\//) {
        print line
      }
    }
  ' "${workflow}" | sort -u
}

probe_nvcr_image_ref() {
  local image_ref="$1"
  local without_host="${image_ref#nvcr.io/}"
  local repo="${without_host}"
  local ref="latest"
  local manifest_url=""
  local status=""
  local anonymous_status=""

  if [[ "${without_host}" == *@* ]]; then
    repo="${without_host%@*}"
    ref="${without_host#*@}"
  elif [[ "${without_host}" == *:* ]]; then
    repo="${without_host%:*}"
    ref="${without_host##*:}"
  fi

  manifest_url="https://nvcr.io/v2/${repo}/manifests/${ref}"

  extract_bearer_challenge_values() {
    local headers_file="$1"
    local challenge=""
    local realm=""
    local service=""
    local scope=""

    challenge="$(awk 'BEGIN{IGNORECASE=1} /^Www-Authenticate:/ {sub(/\r$/, ""); print substr($0, index($0,":")+2); exit}' "${headers_file}")"
    realm="$(printf '%s' "${challenge}" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
    service="$(printf '%s' "${challenge}" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
    scope="$(printf '%s' "${challenge}" | sed -n 's/.*scope="\([^"]*\)".*/\1/p')"
    if [[ -z "${realm}" || -z "${service}" || -z "${scope}" ]]; then
      return 1
    fi

    printf '%s\n%s\n%s' "${realm}" "${service}" "${scope}"
  }

  request_nvcr_bearer_token() {
    local realm="$1"
    local service="$2"
    local scope="$3"
    local use_basic_auth="$4"
    local token_payload=""
    local bearer_token=""

    if [[ "${use_basic_auth}" == "true" ]]; then
      token_payload="$(curl -sS --get \
        -u '$oauthtoken'"":"${NGC_API_KEY}" \
        --data-urlencode "service=${service}" \
        --data-urlencode "scope=${scope}" \
        "${realm}")" || {
        printf '%s' ""
        return
      }
    else
      token_payload="$(curl -sS --get \
        --data-urlencode "service=${service}" \
        --data-urlencode "scope=${scope}" \
        "${realm}")" || {
        printf '%s' ""
        return
      }
    fi

    bearer_token="$(printf '%s' "${token_payload}" | tr -d '\n' | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [[ -z "${bearer_token}" ]]; then
      bearer_token="$(printf '%s' "${token_payload}" | tr -d '\n' | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    fi

    printf '%s' "${bearer_token}"
  }

  probe_nvcr_image_ref_with_bearer_exchange() {
    local target_manifest_url="$1"
    local use_basic_auth="$2"
    local challenge_headers=""
    local probe_status=""
    local challenge_values=""
    local -a challenge_parts=()
    local realm=""
    local service=""
    local scope=""
    local bearer_token=""

    challenge_headers="$(mktemp)"
    probe_status="$(curl -sS -D "${challenge_headers}" -o /dev/null -w '%{http_code}' \
      -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
      "${target_manifest_url}")" || {
      rm -f "${challenge_headers}"
      echo "000"
      return
    }

    case "${probe_status}" in
      200|404|000)
        rm -f "${challenge_headers}"
        echo "${probe_status}"
        return
        ;;
    esac

    if [[ "${probe_status}" != "401" ]]; then
      rm -f "${challenge_headers}"
      echo "${probe_status}"
      return
    fi

    if ! challenge_values="$(extract_bearer_challenge_values "${challenge_headers}")"; then
      rm -f "${challenge_headers}"
      echo "${probe_status}"
      return
    fi
    rm -f "${challenge_headers}"

    while IFS= read -r line; do
      challenge_parts+=("${line}")
    done <<< "${challenge_values}"
    if [[ "${#challenge_parts[@]}" -lt 3 ]]; then
      echo "${probe_status}"
      return
    fi
    realm="${challenge_parts[0]}"
    service="${challenge_parts[1]}"
    scope="${challenge_parts[2]}"

    bearer_token="$(request_nvcr_bearer_token "${realm}" "${service}" "${scope}" "${use_basic_auth}")"
    if [[ -z "${bearer_token}" ]]; then
      echo "${probe_status}"
      return
    fi

    probe_status="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${bearer_token}" \
      -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
      "${target_manifest_url}")" || {
      echo "000"
      return
    }

    echo "${probe_status}"
  }

  if [[ -n "${NGC_API_KEY:-}" ]]; then
    status="$(probe_nvcr_image_ref_with_bearer_exchange "${manifest_url}" "true")"
    case "${status}" in
      200|404|000)
        echo "${status}"
        return
        ;;
      401|403)
        anonymous_status="$(probe_nvcr_image_ref_with_bearer_exchange "${manifest_url}" "false")"
        case "${anonymous_status}" in
          200|404|000)
            echo "${anonymous_status}"
            return
            ;;
        esac
        echo "${status}"
        return
        ;;
      *)
        echo "${status}"
        return
        ;;
    esac
  fi

  probe_nvcr_image_ref_with_bearer_exchange "${manifest_url}" "false"
}

run_workflow_registry_probe() {
  local workflow="$1"
  local image_refs=""
  local image_ref=""
  local status=""
  local ok_count=0
  local -a denied_refs=()
  local -a missing_refs=()
  local -a other_failures=()
  local -a network_failures=()

  if [ ! -f "${workflow}" ]; then
    echo "Workflow image probe skipped: workflow file not found: ${workflow}" >&2
    return 0
  fi

  image_refs="$(extract_workflow_nvcr_images "${workflow}")"
  if [ -z "${image_refs}" ]; then
    echo "Workflow image probe skipped: no nvcr.io images found in ${workflow}" >&2
    return 0
  fi

  echo "Probing nvcr.io access for workflow images in ${workflow}:" >&2
  while IFS= read -r image_ref; do
    [ -n "${image_ref}" ] || continue
    status="$(probe_nvcr_image_ref "${image_ref}")"
    case "${status}" in
      200)
        echo "  OK registry access: ${image_ref}" >&2
        ok_count=$((ok_count + 1))
        ;;
      000)
        echo "  WARN registry probe network error (HTTP 000): ${image_ref}" >&2
        network_failures+=("${image_ref}")
        ;;
      401|403)
        echo "  FAIL registry access denied (HTTP ${status}): ${image_ref}" >&2
        denied_refs+=("${image_ref} (HTTP ${status})")
        ;;
      404)
        echo "  FAIL registry image ref not found (HTTP 404): ${image_ref}" >&2
        missing_refs+=("${image_ref} (HTTP 404)")
        ;;
      *)
        echo "  FAIL registry probe returned HTTP ${status}: ${image_ref}" >&2
        other_failures+=("${image_ref} (HTTP ${status})")
        ;;
    esac
  done <<< "${image_refs}"

  if [[ "${missing_refs[0]+__set__}" == "__set__" ]]; then
    echo "NGC registry probe found missing/unpublished workflow image refs:" >&2
    printf '  - %s\n' "${missing_refs[@]}" >&2
    echo "Update/sync workflow image tags, then rerun preflight." >&2
    return 1
  fi

  if [[ "${denied_refs[0]+__set__}" == "__set__" ]]; then
    echo "NGC registry probe reported HTTP 401/403 on workflow image refs:" >&2
    printf '  - %s\n' "${denied_refs[@]}" >&2
    echo "The probe already attempted anonymous bearer access and, when provided, credentialed access." >&2
    echo "Treat this as a registry accessibility/policy issue (egress, proxy, auth challenge flow, or image visibility), not as a key-prefix issue." >&2
    return 1
  fi

  if [[ "${other_failures[0]+__set__}" == "__set__" ]]; then
    echo "NGC registry probe failed with non-auth errors:" >&2
    printf '  - %s\n' "${other_failures[@]}" >&2
    echo "Verify nvcr.io availability and workflow image refs, then rerun preflight." >&2
    return 1
  fi

  if [[ "${network_failures[0]+__set__}" == "__set__" ]]; then
    echo "NGC registry probe had network errors for some image refs; verify connectivity if image pulls fail later." >&2
  fi

  if [ "${ok_count}" -gt 0 ]; then
    registry_probe_checked=true
  fi
  return 0
}

# This preflight intentionally does not require or create a local workload .env.
# Flow-level storage/cache values are supplied at submit time via --set-string.

ngc_org="$(resolve_ngc_scope_value org)"
ngc_team="$(resolve_ngc_scope_value team)"
ngc_probe_url=""
if [ -n "${ngc_org}" ] && [ -n "${ngc_team}" ]; then
  ngc_probe_url="https://api.ngc.nvidia.com/v2/org/${ngc_org}/team/${ngc_team}/models/cosmos-anomalygen-pcb/versions/1.0"
else
  echo "NGC org/team not set; skipping org/team-scoped NGC probe." >&2
  echo "Set NGC_ORG+NGC_TEAM (or NGC_CLI_ORG/NGC_CLI_TEAM) to re-enable strict NGC scope probing." >&2
fi
hf_probe_url="https://huggingface.co/api/models/nvidia/Cosmos-Predict2-2B-Text2Image"

# 1) Check existing OSMO credentials first
present=$(osmo credential list | awk 'NR>1 {print $1}' | sort -u)
need_hf=false
grep -qx 'hf_token' <<<"$present" || need_hf=true

# 2) Only require env vars when corresponding required OSMO credentials are missing
if [ -z "${NGC_API_KEY:-}" ]; then
  discovered_ngc_api_key="$(resolve_ngc_api_key)"
  if [ -n "${discovered_ngc_api_key}" ]; then
    export NGC_API_KEY="${discovered_ngc_api_key}"
    echo "AUTO_SECRET_LOADED: NGC API key discovered from environment (nvapi* preferred)." >&2
  fi
fi
if [ -z "${HF_TOKEN:-}" ]; then
  discovered_hf_token="$(resolve_hf_token)"
  if [ -n "${discovered_hf_token}" ]; then
    export HF_TOKEN="${discovered_hf_token}"
    echo "AUTO_SECRET_LOADED: HF token discovered from local cache." >&2
  fi
fi

missing_env=()
if $need_hf && [[ -z "${HF_TOKEN:-}" ]]; then
  missing_env+=(HF_TOKEN)
fi
if [[ "${missing_env[0]+__set__}" == "__set__" ]]; then
  echo "Missing required secrets to create absent OSMO credentials:" >&2
  printf '  - %s\n' "${missing_env[@]}" >&2
  echo "Provide them via agent secret input or runtime secret manager, then rerun preflight." >&2
  emit_user_input_required "Provide missing secrets for absent credentials: ${missing_env[*]}"
  exit 1
fi

# 3) Workflow image registry probe (best signal for runtime image access)
if $probe && [ -n "${workflow_file}" ]; then
  run_workflow_registry_probe "${workflow_file}" || exit 1
elif $probe && [ -z "${workflow_file}" ]; then
  echo "Workflow image probe skipped: pass --workflow <workflow-yaml> to validate exact nvcr.io image refs." >&2
fi

# 4) NGC REST model probe (informational scope signal; distinct from registry image access)
if $probe && [ -n "${ngc_probe_url}" ] && [[ -n "${NGC_API_KEY:-}" ]]; then
  ngc_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $NGC_API_KEY" \
    "$ngc_probe_url")
  if [[ "$ngc_status" != "200" ]]; then
    echo "NGC REST probe failed (HTTP $ngc_status) at $ngc_probe_url" >&2
    if [[ "$ngc_status" == "401" || "$ngc_status" == "403" ]]; then
      echo "  This indicates missing NGC REST model scope for ${ngc_org}/${ngc_team}." >&2
      echo "  It is NOT a direct workflow-image pull check." >&2
      if $registry_probe_checked; then
        echo "  Workflow nvcr.io image access checks passed; continuing." >&2
      else
        echo "  To validate runtime image access, rerun with --workflow <workflow-yaml>." >&2
      fi
    elif [[ "$ngc_status" == "000" ]]; then
      echo "  Network error reaching api.ngc.nvidia.com. Re-run with --no-probe if needed." >&2
    fi
  fi
fi

# 5) HF gated repo probe (only when key provided)
if $probe && [[ -n "${HF_TOKEN:-}" ]]; then
  hf_status=$(curl -sS -o /dev/null -w '%{http_code}' -I \
    -H "Authorization: Bearer $HF_TOKEN" \
    "$hf_probe_url")
  if [[ "$hf_status" != "200" ]]; then
    echo "HF gated-repo probe failed (HTTP $hf_status) at $hf_probe_url" >&2
    if [[ "$hf_status" == "401" || "$hf_status" == "403" ]]; then
      echo "  HF_TOKEN cannot read required gated Cosmos repos. Accept licenses at:" >&2
      echo "    https://huggingface.co/nvidia/Cosmos-Predict2-2B-Text2Image" >&2
      echo "    https://huggingface.co/nvidia/Cosmos-Predict2-14B-Text2Image" >&2
      emit_user_input_required "Confirm HF license acceptance for Cosmos gated repos and provide a valid HF_TOKEN"
    elif [[ "$hf_status" == "000" ]]; then
      echo "  Network error reaching huggingface.co. Re-run with --no-probe." >&2
    fi
    exit 1
  fi
fi

# 6) Ensure required OSMO credentials exist (hf_token required; nvcr_io optional for public images)
if ! grep -qx 'nvcr_io' <<<"$present"; then
  if [[ -n "${NGC_API_KEY:-}" ]]; then
    echo ">>> setting OSMO credential nvcr_io from NGC_API_KEY" >&2
    osmo credential set nvcr_io --type REGISTRY \
      --payload registry=nvcr.io username='$oauthtoken' auth="$NGC_API_KEY"
  else
    echo ">>> nvcr_io credential missing, continuing without it (public nvcr.io pulls expected)." >&2
  fi
elif $refresh_credentials || $user_supplied_ngc_key; then
  if [[ -n "${NGC_API_KEY:-}" ]]; then
    if $refresh_credentials; then
      echo ">>> refreshing existing OSMO credential nvcr_io from NGC_API_KEY (--refresh)" >&2
    else
      echo ">>> refreshing existing OSMO credential nvcr_io from current user-supplied key material" >&2
    fi
    osmo credential set nvcr_io --type REGISTRY \
      --payload registry=nvcr.io username='$oauthtoken' auth="$NGC_API_KEY"
  else
    echo ">>> refresh requested for nvcr_io but NGC_API_KEY is empty; keeping existing credential" >&2
  fi
elif [[ -n "${NGC_API_KEY:-}" ]]; then
  echo ">>> keeping existing OSMO credential nvcr_io (not overwriting). Use --refresh to replace with the current NGC_API_KEY." >&2
else
  echo ">>> keeping existing OSMO credential nvcr_io" >&2
fi

if ! grep -qx 'hf_token' <<<"$present"; then
  echo ">>> setting OSMO credential hf_token from HF_TOKEN" >&2
  osmo credential set hf_token --type GENERIC \
    --payload token="$HF_TOKEN" HF_TOKEN="$HF_TOKEN"
elif $refresh_credentials || $user_supplied_hf_token; then
  if [[ -n "${HF_TOKEN:-}" ]]; then
    if $refresh_credentials; then
      echo ">>> refreshing existing OSMO credential hf_token from HF_TOKEN (--refresh)" >&2
    else
      echo ">>> refreshing existing OSMO credential hf_token from current user-supplied token material" >&2
    fi
    osmo credential set hf_token --type GENERIC \
      --payload token="$HF_TOKEN" HF_TOKEN="$HF_TOKEN"
  else
    echo ">>> refresh requested for hf_token but HF_TOKEN is empty; keeping existing credential" >&2
  fi
elif [[ -n "${HF_TOKEN:-}" ]]; then
  echo ">>> keeping existing OSMO credential hf_token (not overwriting). Use --refresh to replace with the current HF_TOKEN." >&2
else
  echo ">>> keeping existing OSMO credential hf_token (not overwriting)" >&2
fi

present_after=$(osmo credential list | awk 'NR>1 {print $1}' | sort -u)
missing_after=()
for name in hf_token; do
  grep -qx "$name" <<<"$present_after" || missing_after+=("$name")
done
if [[ "${missing_after[0]+__set__}" == "__set__" ]]; then
  echo "OSMO credentials still missing after auto-set:" >&2
  printf '  - %s\n' "${missing_after[@]}" >&2
  echo "Inspect with: osmo credential list" >&2
  exit 1
fi

# 7) OSMO control-plane readiness checks for VDA GPU runs
pool_status=$(osmo pool list --mode free 2>&1) || {
  echo "OSMO pool query failed (osmo pool list --mode free)." >&2
  echo "Resolve OSMO control-plane/profile access before submitting VDA." >&2
  exit 1
}
if ! grep -Eqi 'online' <<<"$pool_status"; then
  echo "No ONLINE pool found in osmo pool list --mode free output." >&2
  echo "Check pool status and default profile before submit." >&2
  exit 1
fi

pod_template=$(osmo config show POD_TEMPLATE 2>&1) || {
  echo "Failed to read POD_TEMPLATE via osmo config show POD_TEMPLATE." >&2
  echo "Use supported control-plane config paths; do not patch DB directly." >&2
  exit 1
}
if ! grep -Eqi 'nvidia\.com/gpu|gpu_toleration' <<<"$pod_template"; then
  echo "POD_TEMPLATE appears to be missing GPU toleration/selectors (nvidia.com/gpu)." >&2
  echo "Fix via osmo config update POD_TEMPLATE or chart values before VDA submit." >&2
  exit 1
fi

echo "OK: required secrets valid; OSMO hf_token credential present."
if grep -qx 'nvcr_io' <<<"$present_after"; then
  echo "NOTE: nvcr_io credential is present."
else
  echo "NOTE: nvcr_io credential is absent; public nvcr.io pulls are expected for current workflow images."
fi
if [ -n "${workflow_file}" ]; then
  echo "NOTE: workflow image access probe used --workflow ${workflow_file}."
else
  echo "NOTE: no --workflow provided; workflow image access probe was skipped."
fi
echo "NOTE: external endpoint credentials (VLM/LLM API keys) are not validated by this script."
echo "NOTE: if runtime readiness checks are inconclusive, ask the user as a final resort instead of guessing."
