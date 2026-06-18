#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# apply_config.sh applies Step 4 configuration edits from inside the container.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# apply_config.sh — ONE docker exec covers all of Step 4 (4.a-4.f).
# Eliminates 6 separate permission prompts for sequential sub-steps.
#
# Dependency order:
#   4.a (discovery) → must finish first, paths needed by 4.b-4.e
#   4.b path-sub + 4.c batch + 4.d sink + 4.e sources — sequential (share ds-main-config.txt)
#   4.f engine-cache-lookup — read-only, runs in parallel with 4.b-4.e via &
#
# Usage (inside container):
#   /tmp/scripts/apply_config.sh \
#       --usecase   <warehouse-2d|warehouse-3d|smartcity-rtdetr|smartcity-gdino> \
#       --batch     <N> \
#       --sink      <fakesink|eglsink|filedump> \
#       --stream-mode <dynamic|static> \
#       [--onnx     <container-side-onnx-path>]   # skip 4.a ONNX discovery if already known
#       [--videos   <container-side-videos-dir>]  # skip 4.a video discovery if already known
#       [--labels   <container-side-labels-path>] # warehouse-3d: override labels.txt path.
#                                                 #   Not normally needed — when --onnx is given,
#                                                 #   apply_config.sh auto-derives labels.txt and
#                                                 #   *.npy from the ONNX parent dir (warehouse NGC
#                                                 #   resource always co-locates them).
#       [--anchor   <container-side-anchor-path>] # warehouse-3d: override anchor *.npy path
#                                                 #   (same auto-co-location as --labels).
#       [--force-rebuild]                          # bypass engine cache
#
# Output markers (parseable by the skill):
#   RESOLVE_OK: <label>=<path>      — 4.a discovery result
#   RESOLVE_MISS: <label> (no match)  — 4.a found zero candidates; skill should run fetch_resources.sh
#   RESOLVE_AMBIGUOUS: <label> count=<N>  — 4.a needs AskQuestion from skill (N >= 2 candidates)
#   BATCH_UPDATE_OK <usecase> <N>   — 4.c done
#   SINK_UPDATE_OK <usecase> <sink> — 4.d done
#   STREAM_SOURCES_OK <usecase> <mode> — 4.e done
#   ENGINE_PRELAUNCH: <HIT_EXACT|HIT_COMPAT|MISS> — 4.f result
#   CONFIG_APPLY_OK usecase=<uc> batch=<N> sink=<sink> — all done

set -euo pipefail

USECASE=""
BATCH=""
SINK="fakesink"
# Default matches references/pipeline-config.md § "Defaults — the skill is
# static-mode by default": eval rubrics for "deploy with N streams" queries
# expect static [source-list] entries baked in before app start. Callers
# can still pass --stream-mode dynamic when the user explicitly asks for
# REST-driven stream attach.
STREAM_MODE="static"
ONNX_OVERRIDE=""
VIDEOS_OVERRIDE=""
LABELS_OVERRIDE=""
ANCHOR_OVERRIDE=""
FORCE_REBUILD=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --usecase)      USECASE="$2";        shift 2 ;;
        --batch)        BATCH="$2";          shift 2 ;;
        --sink)         SINK="$2";           shift 2 ;;
        --stream-mode)  STREAM_MODE="$2";    shift 2 ;;
        --onnx)         ONNX_OVERRIDE="$2";  shift 2 ;;
        --videos)       VIDEOS_OVERRIDE="$2";shift 2 ;;
        --labels)       LABELS_OVERRIDE="$2";shift 2 ;;
        --anchor)       ANCHOR_OVERRIDE="$2";shift 2 ;;
        --force-rebuild) FORCE_REBUILD=1;    shift   ;;
        -h|--help)      sed -n '18,44p' "$0"; exit 0 ;;   # skip SPDX/license header
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

[[ -z "$USECASE" || -z "$BATCH" ]] && { echo "✖ --usecase and --batch are required" >&2; exit 1; }
[[ "$BATCH" =~ ^[1-9][0-9]*$ ]] || { echo "✖ --batch must be a positive integer" >&2; exit 1; }
case "$SINK" in fakesink|eglsink|filedump) ;;
    *) echo "✖ Invalid --sink: $SINK (allowed: fakesink|eglsink|filedump)" >&2; exit 1 ;;
esac
case "$STREAM_MODE" in dynamic|static) ;;
    *) echo "✖ Invalid --stream-mode: $STREAM_MODE (allowed: dynamic|static)" >&2; exit 1 ;;
esac

source /tmp/scripts/common.sh

is_valid_usecase "$USECASE" || {
    echo "✖ Invalid --usecase: $USECASE (allowed: ${USECASES[*]})" >&2
    exit 1
}

export CONFIGS=/opt/nvidia/deepstream/deepstream/sources/apps/sample_apps/metropolis_perception_app/reference-configs
export SPARSE4D_REPO=/opt/nvidia/deepstream/deepstream/sources/sparse4d
export TRITON_REPO=/opt/nvidia/deepstream/deepstream/sources/TritonGdino/triton_model_repo
export RESOURCES=${RESOURCES:-/opt/storage/resources}

# ── 4.a — Discover assets (skip if caller already resolved them) ───────────
echo "→ 4.a: Discovering assets under $RESOURCES"

find_video_dirs() {
    find "$1" -type d 2>/dev/null | while read -r d; do
        ls "$d"/*.mp4 "$d"/*.mkv 2>/dev/null | head -n1 | grep -q . && echo "$d"
    done
}

resolve_unique() {
    local label="$1"; shift
    mapfile -t CANDS < <(find "$@" 2>/dev/null | sort)
    case ${#CANDS[@]} in
        # Distinguish zero-match (no candidates exist, agent should fetch
        # resources, not disambiguate) from multi-match (agent picks one).
        # Matches the RESOLVE_MISS / RESOLVE_AMBIGUOUS convention used by
        # resolve_unique_path in common.sh.
        0) echo "RESOLVE_MISS: $label (no match)" >&2; return 2 ;;
        1) echo "RESOLVE_OK: $label=${CANDS[0]}" >&2; printf '%s' "${CANDS[0]}" ;;
        *) echo "RESOLVE_AMBIGUOUS: $label count=${#CANDS[@]}" >&2
           # Print each candidate on its own line — never pass paths as printf format args
           for i in "${!CANDS[@]}"; do
               printf '  [%d] %s\n' "$i" "${CANDS[$i]}" >&2
           done
           return 3 ;;
    esac
}

# Override helper — use caller-provided path if set, otherwise discover
resolve_or_override() {
    local label="$1" override="$2"; shift 2
    if [[ -n "$override" ]]; then
        echo "RESOLVE_OK: $label=$override" >&2
        printf '%s' "$override"
    else
        resolve_unique "$label" "$@"
    fi
}

# Videos-specific resolver — uses find_video_dirs as the candidate source.
# Can't go through resolve_unique because find_video_dirs emits a list
# of directories (it filters by *.mp4/*.mkv content), not raw find args.
# Wrapping it in <(...) for resolve_unique would expand to /dev/fd/N
# which `find` treats as a single non-directory match and "resolves" to
# itself — silent failure downstream. mapfile reads the list properly.
resolve_videos() {
    local override="$1"
    if [[ -n "$override" ]]; then
        echo "RESOLVE_OK: videos=$override" >&2
        printf '%s' "$override"
        return 0
    fi
    local -a CANDS=()
    mapfile -t CANDS < <(find_video_dirs "$RESOURCES")
    case ${#CANDS[@]} in
        # Zero-match = no candidates (need fetch_resources.sh), not
        # ambiguity. RESOLVE_MISS keeps the agent's recovery path correct.
        0) echo "RESOLVE_MISS: videos (no match)" >&2; return 2 ;;
        1) echo "RESOLVE_OK: videos=${CANDS[0]}" >&2; printf '%s' "${CANDS[0]}" ;;
        *) echo "RESOLVE_AMBIGUOUS: videos count=${#CANDS[@]}" >&2
           for i in "${!CANDS[@]}"; do
               printf '  [%d] %s\n' "$i" "${CANDS[$i]}" >&2
           done
           return 3 ;;
    esac
}

case "$USECASE" in
  warehouse-2d|smartcity-rtdetr)
    ONNX=$(resolve_or_override 'onnx'   "$ONNX_OVERRIDE"   "$RESOURCES" -type f -name '*.onnx') || exit $?
    VIDEOS=$(resolve_videos "$VIDEOS_OVERRIDE")      || exit $?
    ;;
  warehouse-3d)
    # Co-locate labels.txt and *.npy with the ONNX when --onnx is given but
    # --labels / --anchor are not. The warehouse NGC resource always ships
    # all three in the same dir (vss-warehouse-app-data/models/sparse4d/ov/),
    # so this avoids RESOLVE_AMBIGUOUS when other use cases' resources are
    # cached under $RESOURCES (e.g. trafficcamnet labels.txt left over from
    # a prior smartcity-rtdetr deploy).
    if [[ -n "$ONNX_OVERRIDE" ]]; then
        ONNX_DIR=$(dirname "$ONNX_OVERRIDE")
        if [[ -z "$LABELS_OVERRIDE" && -f "$ONNX_DIR/labels.txt" ]]; then
            LABELS_OVERRIDE="$ONNX_DIR/labels.txt"
        fi
        if [[ -z "$ANCHOR_OVERRIDE" ]]; then
            ANCHOR_CAND=$(find "$ONNX_DIR" -maxdepth 1 -type f -name '*.npy' 2>/dev/null | sort | head -1)
            [[ -n "$ANCHOR_CAND" ]] && ANCHOR_OVERRIDE="$ANCHOR_CAND"
        fi
    fi
    ONNX=$(resolve_or_override   'sparse4d-onnx' "$ONNX_OVERRIDE"   "$RESOURCES" -type f -name '*.onnx')      || exit $?
    LABELS=$(resolve_or_override 'labels'        "$LABELS_OVERRIDE" "$RESOURCES" -type f -name 'labels.txt')  || exit $?
    ANCHOR=$(resolve_or_override 'anchor'        "$ANCHOR_OVERRIDE" "$RESOURCES" -type f -name '*.npy')       || exit $?
    CALIB=$(resolve_unique     'calibration'                        "$RESOURCES" -type f -name 'calibration.json') \
        || CALIB="$CONFIGS/warehouse-3d/calibration.json"
    VIDEOS=$(resolve_videos "$VIDEOS_OVERRIDE")      || exit $?
    ;;
  smartcity-gdino)
    # Use override if given; otherwise look for the known gdino filename specifically
    # (not *.onnx — that matches every ONNX in resources and hits RESOLVE_AMBIGUOUS).
    if [[ -n "$ONNX_OVERRIDE" ]]; then
        ONNX="$ONNX_OVERRIDE"
        echo "RESOLVE_OK: gdino-onnx=$ONNX" >&2
    else
        ONNX=$(find "$RESOURCES" -type f -name 'mgdino_mask_head_pruned_dynamic_batch.onnx' 2>/dev/null | sort | head -1) || true
        if [[ -n "$ONNX" ]]; then
            echo "RESOLVE_OK: gdino-onnx=$ONNX" >&2
        else
            echo "RESOLVE_MISS: gdino-onnx (no match) — no mgdino_mask_head_pruned_dynamic_batch.onnx found under \$RESOURCES; run fetch_resources.sh for smartcity-gdino or pass --onnx <path>" >&2
            exit 3
        fi
    fi
    VIDEOS=$(resolve_videos "$VIDEOS_OVERRIDE")      || exit $?
    ;;
esac
echo "    ✔ 4.a: assets resolved"

# ── 4.a.1 — Tracker ReID model (NvDCF_accuracy needs resnet50_market1501.etlt) ─
# warehouse-2d / smartcity-rtdetr / smartcity-gdino all ship with a
# tracker config that references the ReID etlt at
# /opt/nvidia/deepstream/deepstream/samples/models/Tracker/. The etlt
# itself is bundled deeper in the perception-app sources tree — copy it
# into the expected location so the pipeline can reach PLAYING.
# Idempotent and self-locating; harmless for warehouse-3d (Sparse4D).
case "$USECASE" in
  warehouse-2d|smartcity-rtdetr|smartcity-gdino)
    echo "→ 4.a.1: Tracker ReID model (resnet50_market1501.etlt)"
    /tmp/scripts/setup_tracker_reid.sh \
      || echo "    ⚠ 4.a.1: tracker ReID setup failed — pipeline may fail at PLAYING; see warning above" >&2
    ;;
esac

# ── 4.a.2 — Stage + cyclically extend warehouse-3d calibration ────────────
# Runs BEFORE 4.f so the backgrounded setup_sparse4d.sh sees the final
# calibration.json (it copies it into $SPARSE4D_REPO/ at startup, so any
# in-place edit landing after 4.f's bg job is a race).
#
# Two responsibilities:
#   1. Stage NGC-supplied calibration into $CONFIGS (cp from $CALIB).
#   2. If batch > sensor count, generate a cyclically-extended copy whose
#      sensor IDs match discover_streams.sh's `<stem>_<i>` cycle scheme
#      (so Sparse4D finds a projection matrix for every stream id).
#      Cached at /opt/storage/calibrations/calibration_<N>.json for reuse.
if [[ "$USECASE" == "warehouse-3d" ]]; then
    echo "→ 4.a.2: Calibration (stage + cyclically extend for batch=$BATCH)"
    if [[ "$CALIB" != "$CONFIGS/warehouse-3d/calibration.json" ]]; then
        cp "$CALIB" "$CONFIGS/warehouse-3d/calibration.json"
    fi
    CALIB_CACHE_DIR=/opt/storage/calibrations
    mkdir -p "$CALIB_CACHE_DIR"
    # Capture rc explicitly — command substitution can mask set -e in some
    # bash versions, and we want a precise failure message for this step.
    set +e
    EXT_CALIB=$(python3 /tmp/scripts/calibration_manager.py ensure \
        "$CONFIGS/warehouse-3d/calibration.json" \
        --batch-size "$BATCH" \
        --cache-dir "$CALIB_CACHE_DIR")
    CALIB_RC=$?
    set -e
    if (( CALIB_RC != 0 )); then
        echo "✖ 4.a.2: calibration_manager.py ensure failed (rc=$CALIB_RC) — see stderr above. Sparse4D will spam 'No projection matrix found' on cycled streams." >&2
        exit 1
    fi
    if [[ -n "$EXT_CALIB" && "$EXT_CALIB" != "$CONFIGS/warehouse-3d/calibration.json" ]]; then
        cp "$EXT_CALIB" "$CONFIGS/warehouse-3d/calibration.json"
        echo "    ✔ 4.a.2: calibration extended → $EXT_CALIB (sensor IDs match cycled stream IDs)"
    else
        echo "    ✔ 4.a.2: calibration covers batch=$BATCH (no extension needed)"
    fi
fi

ENGINE_PID=0

# ── 4.b — Substitute paths into config placeholders ───────────────────────
echo "→ 4.b: Path substitution"
case "$USECASE" in
  warehouse-2d)
    update_yaml_flat "$CONFIGS/warehouse-2d/ds-ppl-analytics-pgie-config.yml" onnx-file "$ONNX"
    ;;
  warehouse-3d)
    ONNX_BASE=$(basename "$ONNX")
    update_yaml_flat "$CONFIGS/warehouse-3d/config.yaml" onnx_file   "$ONNX"
    update_yaml_flat "$CONFIGS/warehouse-3d/config.yaml" engine_file "$ENGINE_CACHE_DIR/${ONNX_BASE}_b${BATCH}.engine"
    update_yaml_flat "$CONFIGS/warehouse-3d/config.yaml" labels_file "$LABELS"
    update_yaml_flat "$CONFIGS/warehouse-3d/config.yaml" anchor      "$ANCHOR"
    # Calibration is staged + cyclically extended in 4.a.2 (before 4.f)
    ;;
  smartcity-rtdetr)
    update_ds_config "$CONFIGS/smartcities/rt-detr/rtdetr-960x544.txt" "[property]" onnx-file "$ONNX"
    ;;
  smartcity-gdino)
    : # GDINO paths are handled by setup_gdino.sh (4.f bg job, kicked off after 4.e)
    ;;
esac
echo "    ✔ 4.b: paths substituted"

# ── 4.c — Batch size (touches main config + PGIE config) ──────────────────
echo "→ 4.c: Batch size → $BATCH"
/tmp/scripts/update_batch_size.sh "$USECASE" "$BATCH"
echo "    ✔ 4.c: batch=$BATCH applied"

# ── 4.d — Output sink ──────────────────────────────────────────────────────
echo "→ 4.d: Output sink → $SINK"
/tmp/scripts/update_output_sink.sh "$USECASE" "$SINK"
echo "    ✔ 4.d: sink=$SINK applied"

# ── 4.e — Stream sources + file-loop ──────────────────────────────────────
# Static mode needs --urls and --names. We auto-discover them from the
# resolved $VIDEOS directory using discover_streams.sh so the agent never
# has to hand-build the URL list. Dynamic mode just clears [source-list].
echo "→ 4.e: Stream sources → $STREAM_MODE"
SS_ARGS=("$USECASE" "$STREAM_MODE" --batch-size "$BATCH")
if [[ "$STREAM_MODE" == "static" ]]; then
    [[ -n "${VIDEOS:-}" ]] \
        || { echo "✖ 4.e: static mode requires \$VIDEOS — Step 4.a should have resolved it" >&2; exit 1; }
    set +e
    DISCOVER_OUT=$(/tmp/scripts/discover_streams.sh "$USECASE" "$BATCH" \
        --videos-dir "$VIDEOS" --format env --warn-cycle 2>/dev/null)
    DISCOVER_RC=$?
    set -e
    if (( DISCOVER_RC != 0 )); then
        echo "✖ 4.e: discover_streams.sh failed (rc=$DISCOVER_RC) — cannot populate static [source-list]" >&2
        exit 1
    fi
    eval "$DISCOVER_OUT"          # → STREAM_IDS, STREAM_URLS (semicolon-separated)
    SS_ARGS+=(--urls "$STREAM_URLS" --names "$STREAM_IDS")
fi
/tmp/scripts/update_stream_sources.sh "${SS_ARGS[@]}"

# file-loop controls whether [source-list] mp4 sources rewind on EOS:
#   eglsink   → 1 (REQUIRED so the on-screen window keeps showing video
#                 indefinitely while the user inspects the deploy — without
#                 looping, short clips end after a few seconds and the
#                 window goes black).
#   fakesink  → 1 (keep generating frames so REST /metrics stays live and
#                 the deploy summary's FPS readings don't decay to 0).
#   filedump  → 0 (record one pass then stop cleanly; otherwise the output
#                 file grows unbounded).
case "$SINK" in
  eglsink|fakesink) FILE_LOOP=1 ;;
  filedump)         FILE_LOOP=0 ;;
  *)                FILE_LOOP=1 ;;   # unknown sinks default to looping
esac

case "$USECASE" in
  warehouse-2d)
    MAIN="$CONFIGS/warehouse-2d/ds-main-config.txt" ;;
  warehouse-3d)
    MAIN="$CONFIGS/warehouse-3d/ds-main-config.txt" ;;
  smartcity-rtdetr)
    MAIN="$CONFIGS/smartcities/rt-detr/run_config-api-rtdetr-protobuf.txt" ;;
  smartcity-gdino)
    MAIN="$CONFIGS/smartcities/gdino/run_config-api-rtdetr-protobuf.txt" ;;
esac
# file-loop is a `[tests]` group key in DeepStream's nvurisrcbin/source-list
# parser — NOT a `[source-list]` key. Putting it in `[source-list]` produces
# `WARN: Unknown key 'file-loop' for group [source-list]` and the value is
# silently dropped (videos do NOT loop). The shipped configs already have a
# default `[tests] file-loop=0`; we just toggle it sink-aware here.
#
# Cleanup: an earlier version of this script wrote `file-loop=` into
# `[source-list]`, leaving stale invalid entries in any reused container's
# config. Strip them here so DS stops printing the parse warning at launch.
python3 - "$MAIN" <<'PY'
import sys, re
path = sys.argv[1]
with open(path) as f:
    lines = f.readlines()
out, in_source_list, dropped = [], False, 0
for line in lines:
    s = line.lstrip()
    if s.startswith("["):
        in_source_list = (s.rstrip().rstrip("\n") == "[source-list]")
    if in_source_list and re.match(r"^\s*file-loop\s*=", line):
        dropped += 1
        continue
    out.append(line)
if dropped:
    with open(path, "w") as f:
        f.writelines(out)
    print(f"    ✔ 4.e: stripped {dropped} stale [source-list] file-loop= line(s) from {path}")
PY
update_ds_config "$MAIN" "[tests]" file-loop "$FILE_LOOP"

# Verify file-loop actually landed in [tests]. If we silently fail to write
# it (e.g. an unexpected config layout), fakesink/eglsink deploys will EOF
# after a few seconds and the container will exit — which breaks downstream
# usage flows (REST /stream/add returns connection-refused). Fail fast here
# so the agent never proceeds with a non-looping fakesink deploy.
ACTUAL_FILE_LOOP=$(python3 - "$MAIN" <<'PY'
import sys, re
path = sys.argv[1]
in_tests = False
val = ""
with open(path) as f:
    for line in f:
        s = line.lstrip()
        if s.startswith("["):
            in_tests = (s.rstrip().rstrip("\n") == "[tests]")
            continue
        if in_tests:
            m = re.match(r"^\s*file-loop\s*=\s*(\S+)", line)
            if m:
                val = m.group(1)
                break
print(val)
PY
)
if [[ "$ACTUAL_FILE_LOOP" != "$FILE_LOOP" ]]; then
    echo "✖ 4.e: [tests] file-loop verify mismatch — expected=$FILE_LOOP got='${ACTUAL_FILE_LOOP}' in $MAIN" >&2
    exit 1
fi

case "$SINK:$FILE_LOOP" in
  eglsink:1)  LOOP_NOTE="loop forever — keeps display window alive" ;;
  fakesink:1) LOOP_NOTE="loop forever — keeps /metrics FPS live and prevents container exit on EOF" ;;
  filedump:0) LOOP_NOTE="single pass — recording stops cleanly at EOS" ;;
  *)          LOOP_NOTE="" ;;
esac
echo "    ✔ 4.e: stream-mode=$STREAM_MODE, [tests] file-loop=$FILE_LOOP (sink=$SINK${LOOP_NOTE:+ — $LOOP_NOTE})"

# ── 4.f — Heavy engine setup (background, AFTER 4.b/c/d/e). ──────────────
# Runs after all config writes have landed so setup_sparse4d.sh /
# setup_gdino.sh see the fully-updated state. Earlier this block ran BEFORE
# 4.b/c/d/e for parallelism, but setup_sparse4d.sh reads
# $WH3D_CONFIGS/config.yaml to stage it under $SPARSE4D_REPO/configs/, and
# that read raced with 4.b's onnx_file/labels_file/anchor writes to the SAME
# file — sparse4d could end up building an engine from a stale config.
# warehouse-2d / smartcity-rtdetr aren't covered here — their engine setup
# is sequential in 4.g (writers touch the same PGIE config as 4.b/c).
echo "→ 4.f: Heavy engine setup (parallel for sparse4d / gdino; nvinfer runs after in 4.g)"
case "$USECASE" in
  warehouse-3d)
      (
        [[ $FORCE_REBUILD -eq 1 ]] && export FORCE_ENGINE_REBUILD=1
        export LD_PRELOAD=$SPARSE4D_REPO/libmsda_fp16.so
        export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}:$SPARSE4D_REPO:/usr/local/lib/python3/dist-packages/torch/lib"
        /tmp/scripts/setup_sparse4d.sh --batch "$BATCH"
      ) &
      ENGINE_PID=$! ;;
  smartcity-gdino)
      (
        [[ $FORCE_REBUILD -eq 1 ]] && export FORCE_ENGINE_REBUILD=1
        # Pass the already-resolved $ONNX (from Step 4.a auto-discovery or
        # --onnx override) so setup_gdino.sh does NOT perform its own
        # independent resolve_unique_path lookup. Re-discovery races with
        # any concurrent file write under $RESOURCES and can hit
        # RESOLVE_AMBIGUOUS if a second copy of the gdino ONNX ever lands
        # in the tree — apply_config.sh treats setup_gdino failure as a
        # non-fatal warning, so a silent miss here would leave the deploy
        # without a working TRT engine and only surface at inference time.
        /tmp/scripts/setup_gdino.sh --batch "$BATCH" --onnx "$ONNX"
      ) &
      ENGINE_PID=$! ;;
esac

# ── 4.g — nvinfer engine cache lookup (sequential, AFTER all PGIE-config writes) ──
# Must run after 4.b/4.c which write the PGIE config via tmp+mv. Doing this
# in the background subshell at 4.f used to race with those mv calls and the
# `model-engine-file=...` line was silently overwritten — DS then rebuilt
# from ONNX on every deploy (3-5 min wasted) even with the cached engine on
# disk. warehouse-3d / smartcity-gdino aren't affected because their setup
# scripts write to different files; those still run in parallel via 4.f.
case "$USECASE" in
  warehouse-2d)
      echo "→ 4.g: nvinfer engine cache lookup (sequential)"
      [[ $FORCE_REBUILD -eq 1 ]] && export FORCE_ENGINE_REBUILD=1
      /tmp/scripts/prelaunch_nvinfer_engine.sh --onnx "$ONNX" --batch "$BATCH" \
          --pgie-config "$CONFIGS/warehouse-2d/ds-ppl-analytics-pgie-config.yml" ;;
  smartcity-rtdetr)
      echo "→ 4.g: nvinfer engine cache lookup (sequential)"
      [[ $FORCE_REBUILD -eq 1 ]] && export FORCE_ENGINE_REBUILD=1
      /tmp/scripts/prelaunch_nvinfer_engine.sh --onnx "$ONNX" --batch "$BATCH" \
          --pgie-config "$CONFIGS/smartcities/rt-detr/rtdetr-960x544.txt" ;;
esac

# ── Wait for 4.f background engine job (sparse4d / gdino only) ─────────────
if (( ENGINE_PID != 0 )); then
    echo "→ 4.f: Waiting for parallel engine setup..."
    wait $ENGINE_PID
    ENGINE_RC=$?
    if [[ $ENGINE_RC -ne 0 ]]; then
        echo "    ⚠ 4.f: parallel engine setup exited $ENGINE_RC — DS will build on launch (~3-5 min)"
    else
        echo "    ✔ 4.f: parallel engine setup complete"
    fi
fi

echo ""
echo "CONFIG_APPLY_OK usecase=$USECASE batch=$BATCH sink=$SINK stream_mode=$STREAM_MODE"
echo "    model:  $(basename "$ONNX")"
echo "    videos: $(basename "$VIDEOS")"
