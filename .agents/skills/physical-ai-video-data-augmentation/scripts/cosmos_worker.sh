#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
export UV_PROJECT_ENVIRONMENT=/app/.venv
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/endpoint_common.sh"
load_setup_env_or_fail "${SETUP_DIR:-}"
# Export API keys under all names the container code may read.
# External providers often reuse a single NVIDIA/NGC key for VLM+LLM calls.
export OPENAI_API_KEY="${OPENAI_API_KEY:-${VLM_API_KEY:-${LLM_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}}"
export VLM_API_KEY="${VLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}"
export LLM_API_KEY="${LLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}"
# HF CLI (uvx hf download) reads HF_TOKEN, not HUGGING_FACE_HUB_TOKEN
export HF_TOKEN="${HUGGING_FACE_HUB_TOKEN:-${HF_TOKEN:-}}"

_AUTH_HDR="$(make_auth_header "${VLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}")"
_LLM_AUTH_HDR="$(make_auth_header "${LLM_API_KEY:-${OPENAI_API_KEY:-${NVIDIA_API_KEY:-${NGC_CLI_API_KEY:-}}}}")"

_recover_augmented_video_from_tmp() {
    local output_file="$1"
    local candidate
    candidate=$(find /tmp -type f -name "cosmos_transfer_inference.mp4" -print -quit 2>/dev/null)
    if [ -z "${candidate}" ]; then
        return 1
    fi
    cp -f "${candidate}" "${output_file}"
    echo "Recovered augmented video from fallback path: ${candidate}"
    return 0
}

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

cd /app
VIDEO="$(find_first_video_or_fail "${VIDEO_INPUT}" "VIDEO_INPUT" "verify the dataset URL resolves to objects before submit (osmo data list <dataset-url>).")"
CFG="${SETUP_DIR}/configs/${VIDEO_NAME}_aug${AUG_INDEX}.yaml"
mkdir -p "${OUTPUT_DIR}"

# OSMO mounts model cache read-only. HF transformers writes refs/ and lock
# files into the cache dir. Mirror to a writable tmpdir via symlinks.
if [ -n "${HF_HUB_CACHE:-}" ] && [ -d "${HF_HUB_CACHE}" ]; then
    _writable_cache=$(mktemp -d)
    for model_dir in "${HF_HUB_CACHE}"/models--*; do
        [ -d "$model_dir" ] || continue
        _base=$(basename "$model_dir")
        mkdir -p "${_writable_cache}/${_base}"
        for sub in "${model_dir}"/*; do
            ln -sf "$sub" "${_writable_cache}/${_base}/$(basename "$sub")"
        done
    done
    export HF_HUB_CACHE="${_writable_cache}"
    echo "Using writable HF cache at ${_writable_cache}"
fi

COSMOS_EXIT=0
uv run python modules/cli.py --config "$CFG" \
    "data.0.inputs.rgb=${VIDEO}" \
    "data.0.output.video=${OUTPUT_DIR}/augmented_video.mp4" \
    "data.0.output.metadata=${OUTPUT_DIR}/metadata.json" \
    "template_generation.system_prompt_file=${SETUP_DIR}/configs/augmentation/prompts/template_generation_system_prompt.md" \
    "template_generation.prompt_polishing_file=${SETUP_DIR}/configs/augmentation/prompts/prompt_polishing_system_prompt.md" \
    "endpoints.vlm.url=${VLM_URL}" "endpoints.vlm.model=${VLM_MODEL}" \
    "endpoints.llm.url=${LLM_URL}" "endpoints.llm.model=${LLM_MODEL}" \
    video_captioning.parser=instruct || COSMOS_EXIT=$?
if [ "${COSMOS_EXIT}" -ne 0 ]; then
    echo "WARNING: Augmentation CLI exited non-zero for ${VIDEO_NAME}_aug${AUG_INDEX} (exit code ${COSMOS_EXIT}); checking output recovery path."
fi
if [ ! -f "${OUTPUT_DIR}/augmented_video.mp4" ]; then
    if ! _recover_augmented_video_from_tmp "${OUTPUT_DIR}/augmented_video.mp4"; then
        echo "No fallback augmented video was found under /tmp."
    fi
fi
if [ ! -f "${OUTPUT_DIR}/augmented_video.mp4" ]; then
    if [ "${COSMOS_EXIT}" -ne 0 ]; then
        echo "ERROR: augmented_video.mp4 missing and CLI exited non-zero for ${VIDEO_NAME}_aug${AUG_INDEX}"
        exit "${COSMOS_EXIT}"
    fi
    echo "ERROR: augmented_video.mp4 not produced for ${VIDEO_NAME}_aug${AUG_INDEX} — CLI exited 0 but output is missing"
    exit 1
fi
if [ "${COSMOS_EXIT}" -ne 0 ]; then
    echo "WARNING: Augmentation output recovered despite non-zero CLI exit for ${VIDEO_NAME}_aug${AUG_INDEX}; continuing."
fi
echo "=== cosmos_worker complete: ${VIDEO_NAME}_aug${AUG_INDEX} ==="

# Cosmos-stage rendezvous on port 12346 (see run_group_barrier in endpoint_common.sh).
echo "=== Cosmos barrier: rank ${COSMOS_BARRIER_RANK} / ${COSMOS_BARRIER_NUM_NODES} ==="
run_group_barrier \
    "${COSMOS_BARRIER_NUM_NODES}" \
    "${COSMOS_BARRIER_RANK}" \
    "${COSMOS_BARRIER_HOST}" \
    "12346" \
    "${SETUP_DIR}/osmo_barrier.py" \
    "${UV_PROJECT_ENVIRONMENT}/bin/python"
echo "=== Cosmos barrier complete ==="
