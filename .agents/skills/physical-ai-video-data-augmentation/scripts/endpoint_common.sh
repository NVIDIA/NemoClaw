#!/usr/bin/env bash
# Shared endpoint + worker utilities for VDA scripts.

make_auth_header() {
    local token="${1:-}"
    if [ -z "${token}" ]; then
        echo ""
        return
    fi
    if [[ "${token}" == Authorization:* ]]; then
        echo "${token}"
    elif [[ "${token}" == Bearer* ]]; then
        echo "Authorization: ${token}"
    else
        echo "Authorization: Bearer ${token}"
    fi
}

ensure_scheme_url() {
    local raw="${1:-}"
    if [ -z "${raw}" ]; then
        echo ""
        return
    fi
    if [[ "${raw}" == http://* || "${raw}" == https://* ]]; then
        echo "${raw}"
    else
        echo "http://${raw}"
    fi
}

strip_query_fragment() {
    local raw="${1:-}"
    raw="${raw%%\?*}"
    raw="${raw%%\#*}"
    echo "${raw}"
}

openai_candidate_seeds() {
    local raw
    raw="$(ensure_scheme_url "${1:-}")"
    raw="$(strip_query_fragment "${raw}")"
    raw="${raw%/}"
    if [ -z "${raw}" ]; then
        return
    fi

    # Trim known inference endpoint suffixes if user provided a full invoke URL.
    local changed=1
    while [ "${changed}" -eq 1 ]; do
        changed=0
        case "${raw}" in
            */v1/chat/completions) raw="${raw%/v1/chat/completions}"; changed=1 ;;
            */chat/completions) raw="${raw%/chat/completions}"; changed=1 ;;
            */v1/completions) raw="${raw%/v1/completions}"; changed=1 ;;
            */completions) raw="${raw%/completions}"; changed=1 ;;
            */v1/responses) raw="${raw%/v1/responses}"; changed=1 ;;
            */responses) raw="${raw%/responses}"; changed=1 ;;
            */v1/embeddings) raw="${raw%/v1/embeddings}"; changed=1 ;;
            */embeddings) raw="${raw%/embeddings}"; changed=1 ;;
            */v1/models) raw="${raw%/v1/models}"; changed=1 ;;
            */models) raw="${raw%/models}"; changed=1 ;;
        esac
    done

    echo "${raw}"

    local without_scheme="${raw#*://}"
    local host="${without_scheme%%/*}"
    local scheme="${raw%%://*}"
    if [ -n "${host}" ] && [ -n "${scheme}" ]; then
        echo "${scheme}://${host}"
    fi
}

candidate_openai_base_urls() {
    local seed
    local -a seeds=()
    while IFS= read -r seed; do
        [ -n "${seed}" ] && seeds+=("${seed}")
    done < <(openai_candidate_seeds "${1:-}")

    local seen=" "
    local base
    for base in "${seeds[@]}"; do
        [ -n "${base}" ] || continue

        case " ${seen} " in
            *" ${base} "*) ;;
            *)
                echo "${base}"
                seen="${seen}${base} "
                ;;
        esac

        local alt=""
        if [[ "${base}" == */v1 ]]; then
            alt="${base%/v1}"
        else
            alt="${base}/v1"
        fi

        case " ${seen} " in
            *" ${alt} "*) ;;
            *)
                echo "${alt}"
                seen="${seen}${alt} "
                ;;
        esac
    done
}

default_openai_base_url() {
    local raw="${1:-}"
    local first=""
    local c
    while IFS= read -r c; do
        [ -n "${first}" ] || first="${c}"
        if [[ "${c}" == */v1 ]]; then
            echo "${c}"
            return
        fi
    done < <(candidate_openai_base_urls "${raw}")
    echo "${first}"
}

probe_models_json() {
    local base_url="$1"
    local auth_header="${2:-}"
    local models_url="${base_url%/}/models"
    local connect_timeout_s="${ENDPOINT_CURL_CONNECT_TIMEOUT_SECONDS:-5}"
    local max_time_s="${ENDPOINT_CURL_MAX_TIME_SECONDS:-15}"
    local response=""

    if [ -n "${auth_header}" ]; then
        if ! response=$(curl -fsS --connect-timeout "${connect_timeout_s}" --max-time "${max_time_s}" -H "${auth_header}" "${models_url}" 2>/dev/null); then
            return 1
        fi
    else
        if ! response=$(curl -fsS --connect-timeout "${connect_timeout_s}" --max-time "${max_time_s}" "${models_url}" 2>/dev/null); then
            return 1
        fi
    fi

    if printf '%s' "${response}" | grep -q '"data"'; then
        RESOLVED_MODELS_JSON="${response}"
        return 0
    fi
    return 1
}

wait_for_models_ready() {
    local name="$1"
    local raw_url="$2"
    local auth_header="${3:-}"
    local timeout_s="${ENDPOINT_WAIT_TIMEOUT_SECONDS:-180}"
    local interval_s="${ENDPOINT_WAIT_INTERVAL_SECONDS:-10}"
    local max_attempts=$(( timeout_s / interval_s ))
    if [ "${max_attempts}" -lt 1 ]; then max_attempts=1; fi

    local -a candidates=()
    local c
    while IFS= read -r c; do
        [ -n "${c}" ] && candidates+=("${c}")
    done < <(candidate_openai_base_urls "${raw_url}")

    if [ "${candidates[0]+__set__}" != "__set__" ]; then
        echo "ERROR: ${name} endpoint URL is empty or invalid: ${raw_url}" >&2
        return 1
    fi

    local attempt candidate
    for ((attempt=1; attempt<=max_attempts; attempt++)); do
        for candidate in "${candidates[@]}"; do
            if probe_models_json "${candidate}" "${auth_header}"; then
                RESOLVED_ENDPOINT_URL="${candidate}"
                return 0
            fi
        done
        echo "Waiting for ${name} server (${attempt}/${max_attempts}): tried ${candidates[*]}" >&2
        sleep "${interval_s}"
    done

    echo "ERROR: ${name} endpoint not ready after ${timeout_s}s (tried ${candidates[*]})." >&2
    echo "Hint: provide an OpenAI-compatible base URL or invoke URL (NIM/NVCF examples accepted)." >&2
    return 1
}

extract_first_model_id() {
    local payload="${1:-}"
    printf '%s' "${payload}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4
}

find_first_video_or_fail() {
    local input_dir="$1"
    local source_name="$2"
    local hint="${3:-}"
    local video_path=""

    if [ -d "${input_dir}" ]; then
        video_path=$(find "${input_dir}" -type f \( -iname "*.mp4" -o -iname "*.avi" -o -iname "*.mkv" \) -print -quit 2>/dev/null)
    fi

    if [ -n "${video_path}" ]; then
        echo "${video_path}"
        return 0
    fi

    echo "ERROR: no input video found in ${input_dir} (${source_name})." >&2
    if [ ! -d "${input_dir}" ]; then
        echo "ERROR: input directory does not exist: ${input_dir}" >&2
    else
        echo "ERROR: input directory exists but contains no supported video files (*.mp4, *.avi, *.mkv)." >&2
    fi
    if [ -n "${hint}" ]; then
        echo "Hint: ${hint}" >&2
    fi
    exit 1
}

load_setup_env_or_fail() {
    local setup_dir="${1:-}"
    local env_file=""

    if [ -z "${setup_dir}" ]; then
        echo "ERROR: SETUP_DIR is empty; cannot resolve runtime environment file." >&2
        exit 1
    fi
    if [ ! -d "${setup_dir}" ]; then
        echo "ERROR: SETUP_DIR does not exist: ${setup_dir}" >&2
        exit 1
    fi

    if [ -f "${setup_dir}/.env" ]; then
        env_file="${setup_dir}/.env"
    elif [ -f "${setup_dir}/runtime.env" ]; then
        env_file="${setup_dir}/runtime.env"
    else
        echo "ERROR: setup environment file missing in ${setup_dir}." >&2
        echo "Expected one of: .env or runtime.env" >&2
        ls -la "${setup_dir}" >&2 || true
        exit 1
    fi

    # shellcheck disable=SC1090
    set -a; source "${env_file}"; set +a
}

# Within-group rendezvous used at the end of each worker stage. Rank 0 holds the
# barrier until every peer arrives, so the lead worker only exits (terminating the
# OSMO group and any co-located VLM/LLM servers) once the whole stage has finished.
run_group_barrier() {
    local num_nodes="$1"
    local rank="$2"
    local host="$3"
    local port="$4"
    local barrier_script="$5"
    local python_bin="${6:-python3}"

    if [ "${rank}" = "0" ]; then
        "${python_bin}" "${barrier_script}" --num_nodes "${num_nodes}" --rank 0 --port "${port}"
    else
        "${python_bin}" "${barrier_script}" --num_nodes "${num_nodes}" --rank "${rank}" --connect "${host}" --port "${port}"
    fi
}
