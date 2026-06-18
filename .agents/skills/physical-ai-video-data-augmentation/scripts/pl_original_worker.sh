#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
export UV_PROJECT_ENVIRONMENT=/opt/venv
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/endpoint_common.sh"
load_setup_env_or_fail "${SETUP_DIR:-}"
# Export API keys under all names the container code may read.
# External providers often reuse a single NVIDIA/NGC key for VLM+LLM calls.
export OPENAI_API_KEY="${OPENAI_API_KEY:-${VLM_API_KEY:-${LLM_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}}"
export VLM_API_KEY="${VLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}"
export LLM_API_KEY="${LLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}"
export HF_TOKEN="${HUGGING_FACE_HUB_TOKEN:-${HF_TOKEN:-}}"

_AUTH_HDR="$(make_auth_header "${VLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}")"
_LLM_AUTH_HDR="$(make_auth_header "${LLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}")"

_ORIG_VLM_URL="${VLM_URL}"
_ORIG_LLM_URL="${LLM_URL}"
VLM_URL="$(default_openai_base_url "${VLM_URL}")"
LLM_URL="$(default_openai_base_url "${LLM_URL}")"

if [ "${WAIT_FOR_VLM:-0}" = "1" ]; then
    echo "Waiting for VLM server..."
    RESOLVED_ENDPOINT_URL=""
    RESOLVED_MODELS_JSON=""
    wait_for_models_ready "VLM" "${_ORIG_VLM_URL}" "${_AUTH_HDR}"
    VLM_URL="${RESOLVED_ENDPOINT_URL}"
    VLM_MODEL="$(extract_first_model_id "${RESOLVED_MODELS_JSON}")"
    if [ -z "${VLM_MODEL}" ]; then
        echo "ERROR: VLM endpoint responded but no model id found at ${VLM_URL}/models" >&2
        exit 1
    fi
    echo "VLM ready: ${VLM_MODEL} (${VLM_URL})"
fi

if [ "${WAIT_FOR_LLM:-0}" = "1" ]; then
    echo "Waiting for LLM server..."
    RESOLVED_ENDPOINT_URL=""
    RESOLVED_MODELS_JSON=""
    wait_for_models_ready "LLM" "${_ORIG_LLM_URL}" "${_LLM_AUTH_HDR}"
    LLM_URL="${RESOLVED_ENDPOINT_URL}"
    LLM_MODEL="$(extract_first_model_id "${RESOLVED_MODELS_JSON}")"
    if [ -z "${LLM_MODEL}" ]; then
        echo "ERROR: LLM endpoint responded but no model id found at ${LLM_URL}/models" >&2
        exit 1
    fi
    echo "LLM ready: ${LLM_MODEL} (${LLM_URL})"
else
    LLM_MODEL="${LLM_MODEL_STATIC}"
fi
cd /workspace
if [ -f docker/entrypoint.sh ]; then bash docker/entrypoint.sh; fi


# ── rfdetr lock-file workaround ──────────────────────────────────────────────
# rfdetr always creates <weights>.lock before checking if weights exist, so the
# cache dir must be writable. Symlink seedvr2/reid as-is; give rfdetr a real
# writable subdir with the weights file symlinked inside.
if [ -n "${MODEL_CACHE_PATH:-}" ] && [ -d "${MODEL_CACHE_PATH}/rfdetr" ]; then
    _cache_workdir=$(mktemp -d)
    for _item in "${MODEL_CACHE_PATH}"/*; do
        [ -e "${_item}" ] && ln -s "${_item}" "${_cache_workdir}/$(basename "${_item}")"
    done
    rm "${_cache_workdir}/rfdetr"
    mkdir -p "${_cache_workdir}/rfdetr"
    for _f in "${MODEL_CACHE_PATH}/rfdetr"/*; do
        [ -e "${_f}" ] && ln -s "${_f}" "${_cache_workdir}/rfdetr/$(basename "${_f}")"
    done
    MODEL_CACHE_PATH="${_cache_workdir}"
fi

VIDEO="$(find_first_video_or_fail "${VIDEO_INPUT}" "VIDEO_INPUT" "verify setup/input dataset URLs with 'osmo data list' before submit.")"
# --- Auto-labeling (SR enabled/disabled via super_resolution.enabled flag) ---
mkdir -p "${OUTPUT_DIR}"
# Auto-detect cookbook overrides from $SETUP_DIR and apply as CLI overrides.
# This ensures the cookbook's scene-specific files are used instead of
# container-baked defaults. Do NOT use {{output}} paths here — they
# resolve to the setup task's output dir, not the worker's input mount.
_pl_overrides=()
# Sanitize question bank: strip non-schema keys that confuse the MCQ parser.
# The mapper injects the bank verbatim into the LLM prompt and its output
# extractor is brace-balanced — stray {…} in _meta etc. short-circuit parsing.
_question_bank="${SETUP_DIR}/configs/auto_labeling/question_bank.json"
if [ -f "${_question_bank}" ]; then
    _bank_clean=$(mktemp --suffix=.json)
    python3 -c "import json; d=json.load(open('${_question_bank}')); json.dump({'name':d['name'],'questions':d['questions']}, open('${_bank_clean}','w'))"
    _pl_overrides+=("mcq_generation.window_metadata_extraction.question_bank_file=${_bank_clean}")
fi
_event_prompt="${SETUP_DIR}/configs/auto_labeling/prompts/event_analysis.md"
if [ -f "${_event_prompt}" ]; then
    _pl_overrides+=("vlm_json.scene_prompt_file=${_event_prompt}" "vlm_json.events_prompt_file=${_event_prompt}")
else
    echo "WARNING: cookbook event_analysis.md not found at ${_event_prompt} — using container default"
fi
PL_EXIT=0
uv run python modules/cli.py \
    --config "${SETUP_DIR}/configs/auto_labeling/auto_labeling_config.yaml" \
    data.0.inputs.video_path="${VIDEO}" data.0.output.out_dir="${OUTPUT_DIR}" \
    pipeline.model_cache_path="${MODEL_CACHE_PATH:-ckpts}" pipeline.gpu_ids=0 \
    super_resolution.enabled="${SUPER_RESOLUTION_ENABLED:-false}" \
    endpoints.vlm.url="${VLM_URL}" endpoints.vlm.model="${VLM_MODEL}" \
    endpoints.llm.url="${LLM_URL}" endpoints.llm.model="${LLM_MODEL}" \
    "${_pl_overrides[@]}" || PL_EXIT=$?
if [ "${PL_EXIT}" -ne 0 ]; then
    echo "ERROR: PL failed for ${VIDEO_NAME} (exit code ${PL_EXIT})"
    exit "${PL_EXIT}"
fi
echo "=== pl_original_worker complete: ${VIDEO_NAME} ==="

# Original auto-labeling rendezvous on port 12344 (see run_group_barrier in endpoint_common.sh).
echo "=== Barrier: rank ${BARRIER_RANK} / ${BARRIER_NUM_NODES} nodes ==="
run_group_barrier "${BARRIER_NUM_NODES}" "${BARRIER_RANK}" "${BARRIER_HOST}" "12344" "${SETUP_DIR}/osmo_barrier.py" "python3"
echo "=== Barrier complete ==="
