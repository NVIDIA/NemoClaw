#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# start_app_in_container.sh wraps Step 5 launch setup in one host-side call.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# start_app_in_container.sh — Step 5 host-side wrapper.
#
# Replaces FIVE chained docker calls (refresh scripts + chmod + X11
# pre-flight + write_deployment_log.sh + run_app_and_wait.sh) with ONE
# host-side script invocation so the user only sees one permission
# prompt for all of Step 5.
#
# Usage:
#   start_app_in_container.sh \
#       --container <name> \
#       --usecase   <warehouse-2d|warehouse-3d|smartcity-rtdetr|smartcity-gdino> \
#       --batch     <N> \
#       --sink      <fakesink|eglsink|filedump> \
#       --stream-mode <dynamic|static> \
#       [--onnx     <container-onnx-path>] \
#       [--videos   <container-videos-dir>] \
#       [--delay    <seconds>] \
#       [--timeout  <seconds>] \
#       [--no-metrics] \
#       \
#       # Optional metadata for the deployment log header:
#       [--image      <docker-image-ref>] \
#       [--ngc        <ngc-resource-ref-or-local>] \
#       [--platform   <x86-dgpu|sbsa|jetson>] \
#       [--input-type <filesrc|rtsp>] \
#       [--docker-cmd <docker-run-cmdline>]
#
# Wrapper-specific:
#   --container <name>     (default: rtvicv-perception-docker)
#   --skill-dir <path>     (default: $HOME/.claude/skills/vss-deploy-detection-tracking-2d)
#
# Prints the deployment log path on success. Exits with
# run_app_and_wait.sh's exit code.

set -euo pipefail

CONTAINER="${CONTAINER:-rtvicv-perception-docker}"
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/vss-deploy-detection-tracking-2d}"

USECASE=""; BATCH=""; SINK=""; STREAM_MODE=""
ONNX=""; VIDEOS=""; DELAY=""; TIMEOUT=""; NO_METRICS=0
IMAGE="?"; NGC="?"; PLATFORM="?"; INPUT_TYPE="filesrc"; DOCKER_CMD=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --container)   CONTAINER="$2";   shift 2 ;;
        --skill-dir)   SKILL_DIR="$2";   shift 2 ;;
        --usecase)     USECASE="$2";     shift 2 ;;
        --batch)       BATCH="$2";       shift 2 ;;
        --sink)        SINK="$2";        shift 2 ;;
        --stream-mode) STREAM_MODE="$2"; shift 2 ;;
        --onnx)        ONNX="$2";        shift 2 ;;
        --videos)      VIDEOS="$2";      shift 2 ;;
        --delay)       DELAY="$2";       shift 2 ;;
        --timeout)     TIMEOUT="$2";     shift 2 ;;
        --no-metrics)  NO_METRICS=1;     shift   ;;
        --image)       IMAGE="$2";       shift 2 ;;
        --ngc)         NGC="$2";         shift 2 ;;
        --platform)    PLATFORM="$2";    shift 2 ;;
        --input-type)  INPUT_TYPE="$2";  shift 2 ;;
        --docker-cmd)  DOCKER_CMD="$2";  shift 2 ;;
        -h|--help)     sed -n '18,51p' "$0"; exit 0 ;;   # skip SPDX/license header
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

[[ -n "$USECASE" && -n "$BATCH" && -n "$SINK" && -n "$STREAM_MODE" ]] \
    || { echo "✖ --usecase, --batch, --sink, --stream-mode are required" >&2; exit 1; }

[[ -d "$SKILL_DIR/scripts" ]] \
    || { echo "✖ scripts dir not found at $SKILL_DIR/scripts" >&2; exit 1; }
docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}' | grep -qx "$CONTAINER" \
    || { echo "✖ container $CONTAINER not running (docker ps)" >&2; exit 1; }

echo "→ start_app_in_container: refresh scripts + write log + launch app in $CONTAINER"

# 1. Refresh scripts inside container (idempotent).
docker exec "$CONTAINER" rm -rf /tmp/scripts
docker cp   "$SKILL_DIR/scripts" "$CONTAINER:/tmp/"
docker exec "$CONTAINER" chmod -R +x /tmp/scripts/

# 2. X11 pre-flight (eglsink only).
if [[ "$SINK" == "eglsink" ]]; then
    HOST_DISPLAY="${DISPLAY:-:0}"
    [[ "$HOST_DISPLAY" != :* ]] && HOST_DISPLAY=":$HOST_DISPLAY"
    docker exec "$CONTAINER" sh -c "ls /tmp/.X11-unix/X${HOST_DISPLAY#:} >/dev/null 2>&1" \
        || { echo "✖ X11 socket missing in container for DISPLAY=$HOST_DISPLAY" >&2; exit 1; }
    xhost +local:root >/dev/null 2>&1 || true
    DISPLAY_ENV=(-e DISPLAY="$HOST_DISPLAY" -e XAUTHORITY=/root/.Xauthority)
else
    DISPLAY_ENV=()
fi

# 3. If the caller didn't supply --docker-cmd, synthesise the full
#    `docker run …` equivalent for the existing container so the log
#    header shows the actual mounts / GPU / network / env in effect —
#    not just `docker start <name>`. Works for reuse / restart / fresh
#    launch alike (the synthesizer reads `docker inspect`).
if [[ -z "$DOCKER_CMD" ]]; then
    DOCKER_CMD=$(bash "$SKILL_DIR/scripts/synthesize_docker_run.sh" "$CONTAINER" 2>/dev/null) \
        || DOCKER_CMD="(docker inspect failed — pass --docker-cmd to override)"
fi

# 4. Initialise the structured deployment log (header + settings + every
#    config file's content). LOG path is printed by the script on stdout.
APP_CMD_STR="./metropolis_perception_app -c <main-config>"
[[ "$SINK" == "eglsink" || "$SINK" == "filedump" ]] && APP_CMD_STR+=" --tiledtext"

LOG=$(docker exec "$CONTAINER" /tmp/scripts/write_deployment_log.sh \
        --usecase     "$USECASE" \
        --batch       "$BATCH" \
        --sink        "$SINK" \
        --stream-mode "$STREAM_MODE" \
        --input-type  "$INPUT_TYPE" \
        --videos      "${VIDEOS:-?}" \
        --image       "$IMAGE" \
        --ngc         "$NGC" \
        --platform    "$PLATFORM" \
        --docker-cmd  "$DOCKER_CMD" \
        --app-cmd     "$APP_CMD_STR")
echo "Deployment log: ~/rtvicv-storage/logs/$(basename "$LOG")"

# 4. Build run_app_and_wait.sh args + exec.
RW_ARGS=(--usecase "$USECASE" --batch "$BATCH" --sink "$SINK" --log "$LOG" --stream-mode "$STREAM_MODE")
[[ -n "$ONNX"   ]] && RW_ARGS+=(--onnx   "$ONNX")
[[ -n "$VIDEOS" ]] && RW_ARGS+=(--videos "$VIDEOS")
[[ -n "$DELAY"  ]] && RW_ARGS+=(--delay  "$DELAY")
[[ -n "$TIMEOUT" ]] && RW_ARGS+=(--timeout "$TIMEOUT")
(( NO_METRICS )) && RW_ARGS+=(--no-metrics)

exec docker exec "${DISPLAY_ENV[@]}" "$CONTAINER" \
    /tmp/scripts/run_app_and_wait.sh "${RW_ARGS[@]}"
