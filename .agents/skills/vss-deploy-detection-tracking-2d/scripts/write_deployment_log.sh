#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# write_deployment_log.sh records deployment settings, commands, and results.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# write_deployment_log.sh - Create a structured deployment log file at
# $STORAGE/logs/<usecase-and-model>_<timestamp>.txt (e.g.
# warehouse2d-rtdetr_20260420_113000.txt) containing:
#   1. Settings & params (use case, batch, sink, image, NGC resource, videos, ...)
#   2. Docker run command
#   3. Dumped contents of every config file this use case uses (PGIE, main,
#      tracker, calibration, Triton pbtxt, ...)
#   4. The metropolis_perception_app command that will be run
#
# The caller then APPENDS the app's runtime stdout/stderr to the same file:
#   LOG=$(write_deployment_log.sh --usecase warehouse-2d --batch 4 ...)
#   ./metropolis_perception_app -c <cfg> >> "$LOG" 2>&1
#
# Script prints the log file path on stdout (last line) so the caller can
# capture it.
#
# Usage:
#   write_deployment_log.sh \
#       --usecase <warehouse-2d|warehouse-3d|smartcity-rtdetr|smartcity-gdino> \
#       --batch <N> --sink <fakesink|eglsink|filedump> \
#       --image <docker-image> --ngc <ngc-resource> \
#       [--platform <x86-dgpu|sbsa|jetson>] \
#       [--stream-mode <dynamic|static>] [--input-type <filesrc|rtsp>] \
#       [--videos <path>] [--docker-cmd <multiline-cmd>] \
#       [--app-cmd <the-command-about-to-run>] [--log-file <path>]

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

USECASE=""; BATCH=""; SINK=""; IMAGE=""; NGC=""
PLATFORM=""; STREAM_MODE=""; INPUT_TYPE=""
VIDEOS=""; DOCKER_CMD=""; APP_CMD=""; LOG_FILE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --usecase)      USECASE="$2";     shift 2 ;;
        --batch)        BATCH="$2";       shift 2 ;;
        --sink)         SINK="$2";        shift 2 ;;
        --image)        IMAGE="$2";       shift 2 ;;
        --ngc)          NGC="$2";         shift 2 ;;
        --platform)     PLATFORM="$2";    shift 2 ;;
        --stream-mode)  STREAM_MODE="$2"; shift 2 ;;
        --input-type)   INPUT_TYPE="$2";  shift 2 ;;
        --videos)       VIDEOS="$2";      shift 2 ;;
        --docker-cmd)   DOCKER_CMD="$2";  shift 2 ;;
        --app-cmd)      APP_CMD="$2";     shift 2 ;;
        --log-file)     LOG_FILE="$2";    shift 2 ;;
        -h|--help)      sed -n '18,31p' "$0"; exit 0 ;;
        *)              die "Unknown argument: $1" ;;
    esac
done

[[ -n "$USECASE" ]] || die "--usecase is required"
is_valid_usecase "$USECASE" || die "Invalid use case: $USECASE (valid: ${USECASES[*]})"

# redact_secrets — defensively strip API keys and Authorization headers from
# anything written to the log. The log file is consumed for debugging and
# may be shared / attached to bug reports, so a future caller passing
# `-e NGC_API_KEY=...` in --docker-cmd or `Authorization: Bearer ...` in
# --app-cmd would otherwise leak the credential.
#
# Implemented in Python re.sub rather than a sed chain so that BOTH bare
# tokens AND quoted ('single' / "double") credential values are
# redacted uniformly. Greptile P1: the previous sed patterns used
# [^[:space:]"']+ which failed at the opening quote of a quoted value,
# silently letting the raw token through.
#
# The -p pattern additionally uses a negative lookahead to skip docker
# port mappings (NUM, NUM:NUM, NUM:NUM/proto) so a `docker run -p
# 9000:9000` doesn't get falsely redacted in the deploy-command log.
redact_secrets() {
    local PY_SCRIPT
    PY_SCRIPT=$(cat <<'PY_EOF'
import re, sys

# Value matcher that accepts any of:
#   - "double-quoted any content"
#   - 'single-quoted any content'
#   - bare token (no whitespace, no quotes)
VAL = r'(?:"[^"]*"|\'[^\']*\'|[^\s"\']+)'

PATTERNS = (
    # NGC_API_KEY=<value>  (env-var form; case-sensitive)
    (re.compile(r'(NGC_API_KEY=)' + VAL),                               r'\1<REDACTED>'),
    # api_key=… / api-key=…  (case-insensitive, any provider)
    (re.compile(r'(api[_-]?key=)' + VAL, re.IGNORECASE),                r'\1<REDACTED>'),
    # --api_key=… / --api-key …
    (re.compile(r'(--api[_-]?key[= ])' + VAL, re.IGNORECASE),           r'\1<REDACTED>'),
    # Authorization: <scheme> <token>
    (re.compile(r'(Authorization:\s*[A-Za-z]+\s+)' + VAL, re.IGNORECASE), r'\1<REDACTED>'),
    # -p <value> — but NOT when the value is a docker port mapping
    # (NUM, NUM:NUM, NUM:NUM/proto, or HOST_IP:NUM:NUM forms).
    (re.compile(
        r'(-p\s+)'
        # Negative lookahead: a docker -p port-mapping value followed
        # by whitespace or end-of-string.
        r'(?!(?:[0-9.]+:)?[0-9]+(?::[0-9]+)?(?:/\w+)?(?:\s|$))'
        + VAL
    ), r'\1<REDACTED>'),
)

for line in sys.stdin:
    for pat, repl in PATTERNS:
        line = pat.sub(repl, line)
    sys.stdout.write(line)
PY_EOF
)
    python3 -c "$PY_SCRIPT"
}

LOGS_DIR="${STORAGE}/logs"
mkdir -p "$LOGS_DIR"
TS=$(date +%Y%m%d_%H%M%S)

# Build a use-case-and-model log prefix so `ls -1 ~/rtvicv-storage/logs/`
# tells the reader at a glance which use case AND which model produced
# each deploy. The skill's logs/ dir is shared across every use case;
# the model dimension matters because warehouse can run RT-DETR (2d) or
# Sparse4D (3d), and smartcity can run RT-DETR or GDINO. USECASE is
# already validated against the registered set above, so it's
# filename-safe.
case "$USECASE" in
    warehouse-2d)      LOG_PREFIX=warehouse2d-rtdetr   ;;
    warehouse-3d)      LOG_PREFIX=warehouse3d-sparse4d ;;
    smartcity-rtdetr)  LOG_PREFIX=smartcity-rtdetr     ;;
    smartcity-gdino)   LOG_PREFIX=smartcity-gdino      ;;
    *)                 LOG_PREFIX="$USECASE"           ;;
esac

# Filename shape: <usecase-and-model>_<TS>.txt
#   e.g. warehouse2d-rtdetr_20260508_142359.txt
#        smartcity-gdino_20260508_100917.txt
# No `deployment_` prefix — the directory ($LOGS_DIR) already implies
# "deployment log".
: "${LOG_FILE:=$LOGS_DIR/${LOG_PREFIX}_${TS}.txt}"

# Per-use-case config files to dump, each with a human-readable description.
# Format: "<absolute-path>|<description>"  (pipe-separated pairs).
# Add entries here when adding new use cases or config files.
case "$USECASE" in
    warehouse-2d)
        CONFIG_FILES=(
            "$CONFIGS/warehouse-2d/ds-main-config.txt|Main DeepStream Config File"
            "$CONFIGS/warehouse-2d/ds-ppl-analytics-pgie-config.yml|PGIE Config File (RT-DETR nvinfer)"
            "$CONFIGS/warehouse-2d/ds-detector-labels.txt|Detector Labels File (7 classes)"
        )
        ;;
    warehouse-3d)
        CONFIG_FILES=(
            "$CONFIGS/warehouse-3d/ds-main-config.txt|Main DeepStream Config File"
            "$CONFIGS/warehouse-3d/config.yaml|Sparse4D Model Config (inference + calibration + preprocessing)"
            "$CONFIGS/warehouse-3d/calibration.json|Camera Calibration File (extrinsics/intrinsics)"
            "$CONFIGS/warehouse-3d/ds-mtmc-preprocess-config.txt|nvdspreprocess Config File"
            "$CONFIGS/warehouse-3d/ds-mtmc-videotemplate_custom_lib_config.txt|videotemplate (Sparse4D plugin) Config File"
        )
        ;;
    smartcity-rtdetr)
        CONFIG_FILES=(
            "$CONFIGS/smartcities/rt-detr/run_config-api-rtdetr-protobuf.txt|Main DeepStream Config File"
            "$CONFIGS/smartcities/rt-detr/rtdetr-960x544.txt|PGIE Config File (RT-DETR nvinfer)"
            "$CONFIGS/smartcities/rt-detr/rtdetr-960x544-labels.txt|Detector Labels File (5 classes)"
        )
        ;;
    smartcity-gdino)
        CONFIG_FILES=(
            "$CONFIGS/smartcities/gdino/run_config-api-rtdetr-protobuf.txt|Main DeepStream Config File"
            "$CONFIGS/smartcities/gdino/config_triton_nvinferserver_gdino.txt|PGIE Config File (GDINO Triton nvinferserver)"
        )
        ;;
esac

# Tracker config — discovered DYNAMICALLY from the use case's main
# config so the log always dumps the file actually loaded at runtime.
# The main config is always the first entry in CONFIG_FILES. Look for
# `[tracker] enable=1` followed by an `ll-config-file=<path>` value.
# Resolves both absolute paths and paths relative to the main config.
MAIN_CFG_ENTRY="${CONFIG_FILES[0]}"
MAIN_CFG_PATH="${MAIN_CFG_ENTRY%%|*}"
if [[ -f "$MAIN_CFG_PATH" ]] \
   && awk '/^\[tracker\]/{f=1; next} /^\[/{f=0} f && /^enable[[:space:]]*=[[:space:]]*1/{ok=1} END{exit !ok}' "$MAIN_CFG_PATH"; then
    TRACKER_CFG=$(awk -F= '/^[[:space:]]*ll-config-file[[:space:]]*=/{gsub(/[[:space:]#].*/, "", $2); print $2; exit}' "$MAIN_CFG_PATH")
    if [[ -n "$TRACKER_CFG" ]]; then
        # Absolute path — use as-is. Relative path — resolve against main config dir.
        if [[ "$TRACKER_CFG" != /* ]]; then
            TRACKER_CFG="$(dirname "$MAIN_CFG_PATH")/$TRACKER_CFG"
        fi
        CONFIG_FILES+=("$TRACKER_CFG|Tracker Config File (resolved from [tracker] ll-config-file= in main config)")
    fi
fi

# Helper: print a major section separator with a title (for top-level sections
# like "Deployment Settings", "Docker Run Command", "Runtime Log").
_hdr() {
    local title="$1"
    printf '\n================================================================================\n'
    printf ' %s\n' "$title"
    printf '================================================================================\n'
}

# Helper: dump a config file with a descriptive label header and a footer
# separator so the log is easy to scan.
#
#   _dump <file> <description>
#
# Produces:
#   ----- BEGIN <description>: <file> -----
#   <content>
#   ----- END <description> -----
_dump() {
    local f="$1" desc="${2:-Config File}"
    printf '\n---------- BEGIN %s: %s ----------\n' "$desc" "$f"
    if [[ -f "$f" ]]; then
        cat "$f"
    else
        echo "(file not found)"
    fi
    printf '\n---------- END %s ----------\n' "$desc"
}

# Write the log file in one shot (>), then everything else appends (>>).
{
    _hdr "RTVI-CV Deployment Log"
    printf 'Log file     : %s\n' "$LOG_FILE"
    printf 'Timestamp    : %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'Host         : %s\n' "$(hostname 2>/dev/null || echo unknown)"
    printf 'User         : %s (uid=%s)\n' "$(id -un)" "$(id -u)"

    _hdr "Deployment Settings"
    printf 'Use case     : %s\n' "$USECASE"
    printf 'Batch size   : %s\n' "${BATCH:-?}"
    printf 'Output sink  : %s\n' "${SINK:-?}"
    printf 'Platform     : %s\n' "${PLATFORM:-?}"
    printf 'Stream mode  : %s\n' "${STREAM_MODE:-?}"
    printf 'Input type   : %s\n' "${INPUT_TYPE:-?}"
    printf 'Videos dir   : %s\n' "${VIDEOS:-?}"
    printf 'Docker image : %s\n' "${IMAGE:-?}"
    printf 'NGC resource : %s\n' "${NGC:-?}"

    _hdr "Docker Run Command"
    printf '%s\n' "${DOCKER_CMD:-(not provided)}" | redact_secrets

    _hdr "App Launch Command"
    printf '%s\n' "${APP_CMD:-(not provided)}" | redact_secrets

    _hdr "Config Files in Use"
    # `local` is a no-op outside a function in bash; use plain vars so the
    # behavior matches the reader's mental model.
    for entry in "${CONFIG_FILES[@]}"; do
        cfg_path="${entry%%|*}"
        cfg_desc="${entry##*|}"
        _dump "$cfg_path" "$cfg_desc"
    done

    _hdr "Runtime Log (metropolis_perception_app stdout/stderr follows)"
} > "$LOG_FILE"

# Print the log path so the caller can capture it.
echo "$LOG_FILE"
