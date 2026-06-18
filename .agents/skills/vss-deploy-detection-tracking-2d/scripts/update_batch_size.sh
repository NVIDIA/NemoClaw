#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# update_batch_size.sh rewrites batch-size settings across use-case configs.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# update_batch_size.sh - Update batch size across ALL config files for a use case.
#
# Usage:
#   update_batch_size.sh <usecase> <batch_size>
#
# Use cases:
#   warehouse-2d      -> ds-main-config.txt + ds-ppl-analytics-pgie-config.yml
#   warehouse-3d      -> ds-main-config.txt + config.yaml + ds-mtmc-preprocess-config.txt
#   smartcity-rtdetr  -> run_config-api-rtdetr-protobuf.txt + rtdetr-960x544.txt
#   smartcity-gdino   -> run_config-api-rtdetr-protobuf.txt + config_triton_nvinferserver_gdino.txt
#                        + 4 Triton config.pbtxt (ensemble_python_gdino, gdino_trt,
#                          gdino_postprocess, gdino_preprocess)
#
# Backups are saved as <file>.bak on first edit. Idempotent.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

USECASE="${1:-}"
BATCH="${2:-}"

case "$USECASE" in
    -h|--help|help) sed -n '18,32p' "$0"; exit 0 ;;
esac
[[ -n "$USECASE" && -n "$BATCH" ]] || die "Usage: $0 <usecase> <batch_size>   (--help for full doc)
Valid use cases: ${USECASES[*]}"
is_valid_usecase "$USECASE" || die "Invalid use case: $USECASE (valid: ${USECASES[*]})"
[[ "$BATCH" =~ ^[1-9][0-9]*$ ]] || die "batch_size must be a positive integer (got: $BATCH)"

echo ">> Updating batch size to $BATCH for use case: $USECASE"

# ── Compute tile grid once; applied to every use case below. ─────
# Tile-grid rule: ROW=floor(sqrt(N)), COL=ceil(N/ROW).
# rows/columns are honored when the tiler composites (eglsink, filedump:
# [tiled-display] enable=1) and ignored when the tiler is in perf-only
# mode (fakesink: [tiled-display] enable=3, no compositing). Harmless to
# set in either case — see update_output_sink.sh for the enable matrix.
#
# Capture the helper's stdout into a variable instead of `read -r ... < <(cmd)`.
# Process substitution masks the helper's exit code from `set -e`, so a
# failure inside compute_tile_grid would silently leave TILE_ROW/TILE_COL
# unset and the rest of the script would substitute empty values into the
# config. Capturing + checking $? makes the failure mode loud and explicit.
TILE_GRID=$(compute_tile_grid "$BATCH") \
    || die "compute_tile_grid failed for batch=$BATCH (rc=$?). Cannot derive tile rows/cols."
read -r TILE_ROW TILE_COL <<<"$TILE_GRID"
[[ -n "$TILE_ROW" && -n "$TILE_COL" ]] \
    || die "compute_tile_grid returned empty rows/cols for batch=$BATCH (output: $TILE_GRID)"
echo "   tile grid : ${TILE_ROW} rows x ${TILE_COL} columns (for batch=${BATCH})"

# Apply tile grid to the main config of a given use case. Called from each
# per-use-case updater below.
_apply_tile_grid() {
    local main="$1"
    update_ds_config "$main" "[tiled-display]" rows    "$TILE_ROW"
    update_ds_config "$main" "[tiled-display]" columns "$TILE_COL"
    echo "   updated $main ([tiled-display] rows=${TILE_ROW} columns=${TILE_COL})"
}

update_warehouse_2d() {
    local main="$CONFIGS/warehouse-2d/ds-main-config.txt"
    local pgie="$CONFIGS/warehouse-2d/ds-ppl-analytics-pgie-config.yml"

    update_ds_config "$main" "[streammux]"    batch-size     "$BATCH"
    update_ds_config "$main" "[primary-gie]"  batch-size     "$BATCH"
    update_ds_config "$main" "[source-list]"  max-batch-size "$BATCH"
    echo "   updated $main  ([streammux] [primary-gie] [source-list])"

    _apply_tile_grid "$main"

    update_engine_filename "$pgie" "$BATCH"
    echo "   updated $pgie (engine filename _b${BATCH}_)"
}

update_warehouse_3d() {
    local main="$CONFIGS/warehouse-3d/ds-main-config.txt"
    local cfg="$CONFIGS/warehouse-3d/config.yaml"
    local prep="$CONFIGS/warehouse-3d/ds-mtmc-preprocess-config.txt"

    update_ds_config "$main" "[streammux]"   batch-size     "$BATCH"
    update_ds_config "$main" "[source-list]" max-batch-size "$BATCH"
    echo "   updated $main  ([streammux] [source-list])"

    _apply_tile_grid "$main"

    update_yaml_flat "$cfg" num_sensors "$BATCH"
    echo "   updated $cfg (num_sensors: $BATCH)"

    # network-input-shape has format N;3;540;960 - replace the leading N
    backup_once "$prep"
    sed -i -E "s/(network-input-shape[[:space:]]*=[[:space:]]*)[0-9]+(;3;540;960)/\1${BATCH}\2/" "$prep"
    echo "   updated $prep (network-input-shape=${BATCH};3;540;960)"
}

update_smartcity_rtdetr() {
    local main="$CONFIGS/smartcities/rt-detr/run_config-api-rtdetr-protobuf.txt"
    local pgie="$CONFIGS/smartcities/rt-detr/rtdetr-960x544.txt"

    update_ds_config "$main" "[streammux]"   batch-size     "$BATCH"
    update_ds_config "$main" "[primary-gie]" batch-size     "$BATCH"
    update_ds_config "$main" "[source-list]" max-batch-size "$BATCH"
    echo "   updated $main  ([streammux] [primary-gie] [source-list])"

    _apply_tile_grid "$main"

    update_ds_config      "$pgie" "[property]" batch-size "$BATCH"
    update_engine_filename "$pgie" "$BATCH"
    echo "   updated $pgie  ([property] batch-size + engine filename)"
}

update_smartcity_gdino() {
    local main="$CONFIGS/smartcities/gdino/run_config-api-rtdetr-protobuf.txt"
    local triton_cfg="$CONFIGS/smartcities/gdino/config_triton_nvinferserver_gdino.txt"

    update_ds_config "$main" "[streammux]"   batch-size     "$BATCH"
    update_ds_config "$main" "[primary-gie]" batch-size     "$BATCH"
    update_ds_config "$main" "[source-list]" max-batch-size "$BATCH"
    echo "   updated $main  ([streammux] [primary-gie] [source-list])"

    _apply_tile_grid "$main"

    # nvinferserver protobuf-style config
    backup_once "$triton_cfg"
    sed -i -E "s/(max_batch_size[[:space:]]*:[[:space:]]*)[0-9]+/\1${BATCH}/" "$triton_cfg"
    echo "   updated $triton_cfg (max_batch_size: $BATCH)"

    # Four Triton config.pbtxt files
    for d in ensemble_python_gdino gdino_trt gdino_postprocess gdino_preprocess; do
        local pb="$TRITON_REPO/$d/config.pbtxt"
        if [[ -f "$pb" ]]; then
            update_pbtxt_max_batch "$pb" "$BATCH"
            echo "   updated $pb (max_batch_size: $BATCH)"
        else
            echo "   skipped missing Triton config: $pb" >&2
        fi
    done
}

case "$USECASE" in
    warehouse-2d)      update_warehouse_2d ;;
    warehouse-3d)      update_warehouse_3d ;;
    smartcity-rtdetr)  update_smartcity_rtdetr ;;
    smartcity-gdino)   update_smartcity_gdino ;;
esac

echo ">> Batch size update complete. Backups saved as *.bak on first edit."
