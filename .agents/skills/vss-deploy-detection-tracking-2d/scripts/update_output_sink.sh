#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# update_output_sink.sh applies fakesink, eglsink, or filedump output config.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# update_output_sink.sh - Apply output-sink configuration for a given use case.
# Updates [sink0], [sink2], [osd], [tiled-display] in the main config based on
# the chosen sink mode (fakesink / eglsink / filedump).
#
# Usage:
#   update_output_sink.sh <usecase> <sink_mode> [--output-file <path>] [--container <1|2>] [--skip-encoder-install]
#
# Arguments:
#   usecase      warehouse-2d | warehouse-3d | smartcity-rtdetr | smartcity-gdino
#   sink_mode    fakesink | eglsink | filedump
#
# Optional flags:
#   --output-file <path>      For filedump, overrides the default output path.
#                             Default: /opt/storage/output/<usecase>_output.mp4
#                             (We keep the .mp4 extension as the standard user-
#                             facing filename regardless of the actual container
#                             muxer chosen — see --container below.)
#   --container <1|2>         Container muxer written to [sink2] container=
#                               1 = MP4  (mp4mux)
#                               2 = MKV  (matroska; DEFAULT — robust on abnormal
#                                         exit: stays playable up to the last
#                                         written frame, unlike MP4's moov atom
#                                         which is only written on clean close.)
#                             The extension and the container are DECOUPLED by
#                             design — the default output file ends in .mp4
#                             (standard extension) while the bytes on disk are
#                             produced by the MKV muxer (robustness). Most
#                             players (VLC / ffmpeg / mpv) auto-detect by
#                             content, not extension, so this plays cleanly.
#                             Override to --container 1 if you strictly need
#                             MP4 bytes (e.g. upload to a pipeline that checks
#                             the moov atom) — at the cost of losing on-kill
#                             recoverability.
#   --skip-encoder-install    For filedump, skip the automatic software encoder
#                             dependency install. Use only if you've verified
#                             x264enc is already available or you're switching
#                             enc-type=0 (hardware) yourself afterwards.
#
# What it writes (all via update_ds_config from common.sh):
#
#   fakesink:
#     [sink0]         enable=1  type=1  nvdslogger=1
#     [sink2]         enable=0
#     [tiled-display] enable=3   (perf-only — emits per-source FPS for
#                                 /api/v1/metrics without rendering)
#     [osd]           enable=0
#
#   eglsink (display):
#     [sink0]         enable=1  type=2  nvdslogger=1
#     [sink2]         enable=0
#     [tiled-display] enable=1  (rows/columns set by update_batch_size.sh)
#     [osd]           enable=1
#     (warehouse-3d only) config.yaml generate_3d_bbox: True
#
#   filedump (file):
#     [sink0]         enable=0  nvdslogger=1  (key written but dormant — sink0 disabled)
#     [sink2]         enable=1  type=3  enc-type=1  codec=1
#                     container=<auto-from-extension>  output-file=<output-file>
#     [tiled-display] enable=1
#     [osd]           enable=1
#
#     Filedump ALSO automatically installs the software video encoder deps
#     (libx264, libx265, ffmpeg mux plugins) inside the container via
#     $DS_ROOT/user_additional_install.sh when `gst-inspect-1.0 x264enc`
#     reports the plugin is missing. The validation is done by gst-inspect
#     — not just a marker file — so a stale
#     /opt/storage/.user_additional_install.done from a previous partial
#     install cannot cause silent "Failed to create sink_sub_bin_encoder1"
#     pipeline-build errors. On success the marker is (re)written.
#
# Why nvdslogger=1 on [sink0] in every mode:
#   /api/v1/metrics returns real per-stream FPS only when an `nvdslogger`
#   element is attached to an enabled sink. None of the shipped reference
#   configs set this on [sink0] (warehouse-2d/3d have it only on [sink1]
#   kafka; smartcity-rtdetr has it commented out). Writing it here means
#   the metrics API works out-of-the-box for fakesink/eglsink (the
#   common cases) and the log-parse fallback in collect_metrics.sh stays
#   only as a safety net. For filedump the key is dormant (sink0
#   enable=0) — no behavior change for that mode.
#
# Why [tiled-display] enable=3 for fakesink:
#   The tiler has three modes — 0=disabled, 1=enabled (composite into a
#   tiled buffer for display), 3=perf-only (no compositing; just emit
#   per-source perf samples that nvdslogger picks up). For fakesink
#   benchmarks there is no display, so we want the perf signals without
#   paying the compositing cost — enable=3 gives the metrics API real
#   per-source FPS while keeping the bench path lean. eglsink stays at 1
#   (compositing required to draw the grid) and filedump stays at 1
#   (the file-write path consumes the composited buffer).
#
# Every edit is verified at the end; the script exits non-zero if any key
# didn't land. Prints "SINK_UPDATE_OK <usecase> <sink_mode>" on success.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

USECASE="${1:-}"
SINK_MODE="${2:-}"
shift $(( $# >= 2 ? 2 : $# )) 2>/dev/null || true

OUTPUT_FILE=""
CONTAINER_OVERRIDE=""
SKIP_ENCODER_INSTALL=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --output-file)           OUTPUT_FILE="$2"; shift 2 ;;
        --container)             CONTAINER_OVERRIDE="$2"; shift 2 ;;
        --skip-encoder-install)  SKIP_ENCODER_INSTALL=1; shift ;;
        -h|--help)               sed -n '18,65p' "$0"; exit 0 ;;
        *)                       die "Unknown argument: $1" ;;
    esac
done
[[ -z "$CONTAINER_OVERRIDE" || "$CONTAINER_OVERRIDE" == "1" || "$CONTAINER_OVERRIDE" == "2" ]] \
    || die "--container must be 1 (MP4) or 2 (MKV); got: $CONTAINER_OVERRIDE"

[[ -n "$USECASE" && -n "$SINK_MODE" ]] || die "Usage: $0 <usecase> <sink_mode> [--output-file <path>]
Use cases: ${USECASES[*]}
Sink modes: fakesink | eglsink | filedump"
is_valid_usecase "$USECASE" || die "Invalid use case: $USECASE (valid: ${USECASES[*]})"

case "$SINK_MODE" in fakesink|eglsink|filedump) ;; *) die "Invalid sink mode: $SINK_MODE (fakesink|eglsink|filedump)" ;; esac

# Resolve the main config path + output-file default for this use case.
case "$USECASE" in
    warehouse-2d)     MAIN="$CONFIGS/warehouse-2d/ds-main-config.txt" ;;
    warehouse-3d)     MAIN="$CONFIGS/warehouse-3d/ds-main-config.txt" ;;
    smartcity-rtdetr) MAIN="$CONFIGS/smartcities/rt-detr/run_config-api-rtdetr-protobuf.txt" ;;
    smartcity-gdino)  MAIN="$CONFIGS/smartcities/gdino/run_config-api-rtdetr-protobuf.txt" ;;
esac
require_file "$MAIN"

# ── Default output file: standard .mp4 extension ─────────────────
# We keep the .mp4 extension as the user-facing standard regardless of
# the actual muxer used — it's the most recognizable video file extension
# and most downstream tooling expects it.
: "${OUTPUT_FILE:=/opt/storage/output/${USECASE}_output.mp4}"

# Hard-cap --output-file to the storage mount so a caller can't redirect
# `rm -f "$OUTPUT_FILE"` (a few lines below) onto a system path. The
# container runs as root, so without this guard a typo or a hostile caller
# could delete arbitrary files.
case "$OUTPUT_FILE" in
    /opt/storage/*|"${STORAGE}"/*) ;;
    *) die "--output-file must be under /opt/storage/ (got: $OUTPUT_FILE)" ;;
esac
case "$OUTPUT_FILE" in
    *..*) die "--output-file must not contain '..' (got: $OUTPUT_FILE)" ;;
esac

# ── Container muxer: default = 2 (MKV, robust on abnormal exit) ───
# `container` enum in ds-main-config.txt [sink2]: 1=MP4, 2=MKV.
#
# Why default=2 (MKV) even when the filename is .mp4?
#
#   MP4's moov atom is written ONLY on a clean close — if the perception
#   app is killed mid-write (Ctrl-C, OOM, crash), the resulting .mp4 file
#   is often unplayable because the moov is missing / incomplete.
#
#   MKV streams are always playable up to the last written frame, which
#   makes them safe during development and interrupted benchmark runs.
#
#   Most players (VLC, ffmpeg, mpv, browsers with content-sniffing)
#   detect the container by the first few bytes — NOT by filename — so
#   MKV bytes inside a .mp4 file play cleanly. The filename is just a
#   convenient label.
#
# Override with --container 1 only when you strictly need MP4 bytes
# on disk (e.g. a downstream tool that parses the moov atom and can't
# handle EBML). That's the tradeoff: MP4 bytes = compatibility, MKV
# bytes = robustness on abnormal exit.
if [[ -n "$CONTAINER_OVERRIDE" ]]; then
    CONTAINER_CODE="$CONTAINER_OVERRIDE"
else
    CONTAINER_CODE=2   # default: MKV muxer regardless of filename extension
fi
case "$CONTAINER_CODE" in
    1) CONTAINER_NAME=MP4 ;;
    2) CONTAINER_NAME=MKV ;;
esac

# ── ensure_encoder_deps — run user_additional_install.sh if x264enc missing ──
# Validates the installation via `gst-inspect-1.0 x264enc` rather than relying
# solely on the marker file — a stale marker (left by a partial install) was
# previously causing silent "Failed to create sink_sub_bin_encoder1" pipeline
# build errors at app launch.
ensure_encoder_deps() {
    local ds_install="/opt/nvidia/deepstream/deepstream/user_additional_install.sh"
    local marker="/opt/storage/.user_additional_install.done"

    # First source of truth: does x264enc actually register as a GStreamer
    # element? If yes, we're done — don't rerun apt-get.
    if gst-inspect-1.0 x264enc >/dev/null 2>&1; then
        echo "   ENCODER_DEPS: x264enc available — skipping install."
        # Refresh the marker so the next call is just as quick.
        [[ -f "$marker" ]] || touch "$marker" 2>/dev/null || true
        return 0
    fi

    if (( SKIP_ENCODER_INSTALL == 1 )); then
        echo "   ENCODER_DEPS: x264enc missing but --skip-encoder-install set. Expect pipeline to fail unless you flip [sink2] enc-type=0 (hardware)." >&2
        return 0
    fi

    if [[ ! -x "$ds_install" ]]; then
        echo "   ENCODER_DEPS: WARNING — $ds_install not found/executable. filedump will likely fail to mux." >&2
        return 0
    fi

    # Stale marker? log it so the reason for the reinstall is obvious.
    if [[ -f "$marker" ]]; then
        echo "   ENCODER_DEPS: stale marker at $marker (x264enc missing) — removing and reinstalling."
        rm -f "$marker"
    fi

    # mktemp avoids the predictable /tmp path that an unprivileged
    # attacker could pre-create as a symlink to redirect the redirect.
    local install_log
    install_log=$(mktemp /tmp/ds_user_install.XXXXXX.log) \
        || { echo "   ENCODER_DEPS: mktemp failed" >&2; return 1; }

    echo "   ENCODER_DEPS: installing software encoders via $ds_install (one-time, ~1-2 min)..."
    (
        cd /opt/nvidia/deepstream/deepstream && ./user_additional_install.sh
    ) >"$install_log" 2>&1 || {
        echo "   ENCODER_DEPS: install FAILED — see $install_log (last 20 lines):" >&2
        tail -20 "$install_log" >&2
        return 1
    }

    # Re-verify via gst-inspect. This is the real success signal — not the
    # exit code of the install script, which has been known to succeed even
    # when the target plugin doesn't land.
    if ! gst-inspect-1.0 x264enc >/dev/null 2>&1; then
        echo "   ENCODER_DEPS: install completed but x264enc still NOT registered. See $install_log." >&2
        return 1
    fi

    touch "$marker"
    echo "   ENCODER_DEPS: install complete, x264enc registered, marker written ✓"
}

echo ">> Updating output sink for $USECASE: $SINK_MODE"
echo "   Main config: $MAIN"

# Derive the per-key values for each sink mode.
case "$SINK_MODE" in
    fakesink)
        SINK0_ENABLE=1; SINK0_TYPE=1
        SINK2_ENABLE=0
        # 3 = tiler perf-only: skips compositing but still emits per-source
        # perf samples that nvdslogger forwards to /api/v1/metrics.
        TILE_ENABLE=3
        OSD_ENABLE=0
        ;;
    eglsink)
        SINK0_ENABLE=1; SINK0_TYPE=2
        SINK2_ENABLE=0
        TILE_ENABLE=1
        OSD_ENABLE=1
        ;;
    filedump)
        # sink0 disabled so the pipeline output goes to sink2's encoder/muxer
        # path instead of the display. Some shipped configs keep sink0 enabled
        # with type=3, but we disable it explicitly so the file-write path is
        # unambiguous.
        SINK0_ENABLE=0; SINK0_TYPE=1
        SINK2_ENABLE=1
        TILE_ENABLE=1
        OSD_ENABLE=1
        ;;
esac

# ── [sink0] ────────────────────────────────────────────────────
update_ds_config "$MAIN" "[sink0]"         enable     "$SINK0_ENABLE"
update_ds_config "$MAIN" "[sink0]"         type       "$SINK0_TYPE"
# nvdslogger=1 is what makes /api/v1/metrics report real FPS. Write
# unconditionally (idempotent via update_ds_config) — dormant when sink0
# is disabled (filedump), active for fakesink/eglsink.
update_ds_config "$MAIN" "[sink0]"         nvdslogger 1

# ── [sink2] (file dump) ────────────────────────────────────────
update_ds_config "$MAIN" "[sink2]"         enable "$SINK2_ENABLE"
if [[ "$SINK_MODE" == "filedump" ]]; then
    # Encoder deps first — if this fails we want to stop BEFORE editing the
    # config, so the user isn't left with a half-applied filedump sink that
    # crashes at pipeline build.
    if ! ensure_encoder_deps; then
        die "Failed to ensure software encoder deps for filedump sink — aborting before config edit."
    fi

    # Only force these when turning filedump ON; avoid churn otherwise.
    update_ds_config "$MAIN" "[sink2]"     type        3                    # 3=File
    update_ds_config "$MAIN" "[sink2]"     container   "$CONTAINER_CODE"    # 1=MP4, 2=MKV (auto from ext)
    update_ds_config "$MAIN" "[sink2]"     codec       1                    # 1=H.264
    update_ds_config "$MAIN" "[sink2]"     enc-type    1                    # 1=Software (deps auto-installed above)
    update_ds_config "$MAIN" "[sink2]"     bitrate     40000000
    update_ds_config "$MAIN" "[sink2]"     output-file "$OUTPUT_FILE"
    # Pre-create the output directory and remove stale file.
    mkdir -p "$(dirname "$OUTPUT_FILE")"
    rm -f "$OUTPUT_FILE"
    echo "   filedump output: $OUTPUT_FILE  (container=$CONTAINER_CODE/$CONTAINER_NAME muxer — extension and muxer are decoupled by design)"
fi

# ── [tiled-display] ────────────────────────────────────────────
update_ds_config "$MAIN" "[tiled-display]" enable "$TILE_ENABLE"

# ── [osd] ──────────────────────────────────────────────────────
update_ds_config "$MAIN" "[osd]"           enable "$OSD_ENABLE"

# ── Warehouse-3d + eglsink: enable 3D bbox rendering in config.yaml ──
if [[ "$USECASE" == "warehouse-3d" && "$SINK_MODE" == "eglsink" ]]; then
    update_yaml_flat "$CONFIGS/warehouse-3d/config.yaml" generate_3d_bbox True
    if [[ -f "$SPARSE4D_REPO/configs/config.yaml" ]]; then
        update_yaml_flat "$SPARSE4D_REPO/configs/config.yaml" generate_3d_bbox True
    fi
    echo "   enabled generate_3d_bbox: True in warehouse-3d/config.yaml"
fi

# ── Verification — catches silent sed failures or wrong-path edits. ──
get_ini() {
    # Extract "key=value" from a specific [section]. Prints the value only.
    local section="$1" key="$2"
    awk -v sec="$section" -v k="$key" '
        $0 == sec { insec=1; next }
        /^\[/     { insec=0 }
        insec && $0 ~ "^"k"=" { sub("^"k"=",""); print; exit }
    ' "$MAIN"
}

fail=0
_check() {
    local label="$1" section="$2" key="$3" expect="$4"
    local actual; actual=$(get_ini "$section" "$key")
    if [[ "$actual" != "$expect" ]]; then
        echo "   FAIL $label  (expected $section $key=$expect, got: ${actual:-<unset>})" >&2
        fail=1
    fi
}
_check "sink0.enable"         "[sink0]"         enable     "$SINK0_ENABLE"
_check "sink0.type"           "[sink0]"         type       "$SINK0_TYPE"
_check "sink0.nvdslogger"     "[sink0]"         nvdslogger 1
_check "sink2.enable"         "[sink2]"         enable     "$SINK2_ENABLE"
if [[ "$SINK_MODE" == "filedump" ]]; then
    _check "sink2.container"  "[sink2]"         container "$CONTAINER_CODE"
    _check "sink2.enc-type"   "[sink2]"         enc-type  1
fi
_check "tiled-display.enable" "[tiled-display]" enable "$TILE_ENABLE"
_check "osd.enable"           "[osd]"           enable "$OSD_ENABLE"

if (( fail != 0 )); then
    echo "SINK_UPDATE_FAIL $USECASE $SINK_MODE — see diffs above" >&2
    exit 1
fi

echo "SINK_UPDATE_OK $USECASE $SINK_MODE"
echo ">> Sink update verified."
