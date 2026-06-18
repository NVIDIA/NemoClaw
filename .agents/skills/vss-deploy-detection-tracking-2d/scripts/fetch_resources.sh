#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# fetch_resources.sh downloads, extracts, and scans NGC assets for a use case.
#
# Licensed under Apache-2.0 (full text: http://www.apache.org/licenses/LICENSE-2.0).

# fetch_resources.sh — Single-script fetch-extract-scan for one usecase.
#
# Replaces the model's pattern of 4-6 separate Bash tool calls (NGC creds
# check → ngc download → scan → tar -xzf → re-scan → rm tarball) with ONE
# invocation that does everything end-to-end, de-dupes shared NGC refs,
# and reports the resolved host + container paths for every asset.
#
# Usage
# -----
#   fetch_resources.sh <usecase>
#
# Optional env vars (override the YAML defaults from deploy-defaults.yml):
#   MODEL_SOURCE   : ngc | local            (default: ngc)
#   MODEL_REF      : NGC ref OR local absolute path
#   VIDEOS_SOURCE  : ngc | local            (default: ngc)
#   VIDEOS_REF     : NGC ref OR local absolute path
#   LABELS_REF     : (warehouse-3d) NGC ref override; default: DEFAULT_LABELS_NGC_REF
#   ANCHOR_REF     : (warehouse-3d) NGC ref override; default: DEFAULT_ANCHOR_NGC_REF
#   RESOURCES_DIR  : default $HOME/rtvicv-storage/resources
#   REMOVE_TARBALLS: 1 to delete *.tar.gz after extract (default: 1)
#
# Output (stdout, KEY=VALUE for the calling skill to capture)
# -----------------------------------------------------------
#   MODEL_FILE_HOST=<absolute host path>
#   MODEL_FILE_CONTAINER=<path inside container>
#   VIDEOS_DIR_HOST=...
#   VIDEOS_DIR_CONTAINER=...
#   LABELS_FILE_HOST=...      # warehouse-3d
#   LABELS_FILE_CONTAINER=...
#   ANCHOR_FILE_HOST=...      # warehouse-3d
#   ANCHOR_FILE_CONTAINER=...
#
# All progress is on stderr (`→ ...`, `✔ ...`, `✖ ...`) so stdout stays
# eval-safe for the caller.
#
# Exit codes
# ----------
#   0  success
#   1  bad arguments
#   2  load_defaults.sh failed for this usecase
#   5  NGC credentials missing — caller MUST prompt user, write
#      ~/.ngc/config with `apikey = <key>`, then re-run this script
#   6  ngc download failed
#   7  tar -xzf failed
#   8  asset not found after fetch (path resolution AND find-by-basename
#      both failed)
#
set -euo pipefail

USECASE="${1:-}"
case "$USECASE" in
    -h|--help|help)
        sed -n '18,63p' "$0"
        exit 0
        ;;
esac
[[ -z "$USECASE" ]] && { echo "ERROR: usage: $0 <usecase>   (run with --help for full doc)" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 0. Pull YAML defaults via load_defaults.sh — reuse the same single source
#    of truth for image picks, NGC refs, paths, kinds, extract_dirs.
_defaults_out=$(bash "$SCRIPT_DIR/load_defaults.sh" "$USECASE") || {
    echo "ERROR: failed to load defaults for $USECASE" >&2
    exit 2
}
eval "$_defaults_out"

# 1. Apply user overrides on top of YAML defaults.
MODEL_SOURCE="${MODEL_SOURCE:-ngc}"
MODEL_REF="${MODEL_REF:-$DEFAULT_MODEL_NGC_REF}"
VIDEOS_SOURCE="${VIDEOS_SOURCE:-ngc}"
VIDEOS_REF="${VIDEOS_REF:-$DEFAULT_VIDEOS_NGC_REF}"
RESOURCES_DIR="${RESOURCES_DIR:-$HOME/rtvicv-storage/resources}"
CONTAINER_RESOURCES="/opt/storage/resources"
REMOVE_TARBALLS="${REMOVE_TARBALLS:-1}"

# Guardrails on RESOURCES_DIR — it's caller-overridable (env var) and is the
# parent of `rm -rf "$stage_dir"` calls below. An empty or root value would
# turn a routine cleanup into a destructive wipe.
[[ -n "$RESOURCES_DIR" ]] || { echo "✖ RESOURCES_DIR cannot be empty" >&2; exit 1; }
[[ "$RESOURCES_DIR" == "/" ]] && { echo "✖ RESOURCES_DIR cannot be '/'" >&2; exit 1; }
case "$RESOURCES_DIR" in /|/usr|/usr/*|/etc|/etc/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/var|/var/*)
    echo "✖ RESOURCES_DIR points at a system path: $RESOURCES_DIR" >&2; exit 1 ;;
esac

mkdir -p "$RESOURCES_DIR"

# 2. NGC credential gate (only if any source is NGC).
need_ngc=0
[[ "$MODEL_SOURCE"  == "ngc" ]] && need_ngc=1
[[ "$VIDEOS_SOURCE" == "ngc" ]] && need_ngc=1

if (( need_ngc == 1 )); then
    if [[ ! -f "$HOME/.ngc/config" ]] || ! grep -q '^apikey' "$HOME/.ngc/config"; then
        echo "✖ NGC credentials missing at ~/.ngc/config — set up first, then re-run." >&2
        exit 5
    fi
    # The credential file holds an ~80-char API key — enforce 0600 so it
    # never lands group/world-readable. Best-effort; warn but don't abort if
    # the chmod fails (e.g. file owned by another user / read-only mount).
    chmod 600 "$HOME/.ngc/config" 2>/dev/null \
        || echo "⚠ Could not chmod 600 ~/.ngc/config — verify file permissions manually." >&2
    echo "→ NGC creds: ok" >&2
fi

# 3. Download + extract a single NGC ref. De-duped via $downloaded_refs.
declare -A downloaded_refs=()

download_ngc() {
    local kind="$1"        # resource | model
    local ref="$2"
    local extract_dir="$3"
    local target="$RESOURCES_DIR/$extract_dir"

    if [[ -n "${downloaded_refs[$ref]:-}" ]]; then
        return 0
    fi

    if [[ -d "$target" && -n "$(ls -A "$target" 2>/dev/null | grep -v '\.tar\.gz$')" ]]; then
        echo "→ Resource cached: $extract_dir (skipping download)" >&2
    else
        # Validate the NGC ref shape before passing it to the CLI — refuse
        # anything that contains shell metachars / whitespace so a malformed
        # ref can't sneak unexpected args through.
        if ! [[ "$ref" =~ ^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]]; then
            echo "✖ Invalid NGC ref format: $ref" >&2
            echo "  Expected: <org>/<team>/<name>:<version>" >&2
            return 6
        fi
        echo "→ Downloading $ref ..." >&2
        ( cd "$RESOURCES_DIR" && ngc registry "$kind" download-version "$ref" >&2 ) || {
            echo "✖ ngc registry $kind download-version $ref failed" >&2
            return 6
        }
    fi

    # Auto-extract any *.tar.gz under the target (one or two levels deep).
    mapfile -t tarballs < <(find "$target" -maxdepth 2 -name '*.tar.gz' -type f 2>/dev/null)
    if (( ${#tarballs[@]} > 0 )); then
        for t in "${tarballs[@]}"; do
            echo "→ Extracting $(basename "$t") ..." >&2
            tar -xzf "$t" -C "$(dirname "$t")" || { echo "✖ tar -xzf $t failed" >&2; return 7; }
            [[ "$REMOVE_TARBALLS" == "1" ]] && rm -f "$t"
        done
    fi

    downloaded_refs[$ref]=1
    return 0
}

# 4. Resolve a single role's canonical path inside the extracted tree.
#    Tries the YAML-default path first, falls back to find-by-basename.
resolve_ngc_role() {
    local role="$1"            # MODEL | VIDEOS | LABELS | ANCHOR
    local ref="$2"
    local extract_dir="$3"
    local rel_path="$4"
    local kind_var="DEFAULT_${role}_KIND"
    local kind="${!kind_var:-resource}"

    download_ngc "$kind" "$ref" "$extract_dir" || return $?

    local host_path="$RESOURCES_DIR/$extract_dir/$rel_path"
    if [[ ! -e "$host_path" ]]; then
        local base; base=$(basename "$rel_path")
        host_path=$(find "$RESOURCES_DIR/$extract_dir" -name "$base" -print -quit 2>/dev/null || true)
    fi
    if [[ -z "$host_path" || ! -e "$host_path" ]]; then
        echo "✖ Could not resolve $role from $ref (looked for $rel_path)" >&2
        return 8
    fi

    local container_path="${host_path/$RESOURCES_DIR/$CONTAINER_RESOURCES}"
    local label="FILE"
    [[ "$role" == "VIDEOS" ]] && label="DIR"
    # Use %q so user-supplied paths containing spaces, quotes, $, backticks,
    # or other shell metacharacters cannot break out of the caller's
    # `eval "$(fetch_resources.sh …)"`. Mirrors discover_streams.sh and
    # load_defaults.sh.
    printf '%s_%s_HOST=%q\n%s_%s_CONTAINER=%q\n' \
        "$role" "$label" "$host_path" \
        "$role" "$label" "$container_path"
    echo "✔ $role: $(basename "$host_path")" >&2
}

# 5. Stage a local file/dir into the storage tree (so the container's
#    bind mount sees it; never symlink — symlinks outside ~/rtvicv-storage
#    dangle inside the container).
resolve_local_role() {
    local role="$1"
    local local_path="$2"

    if [[ ! -e "$local_path" ]]; then
        echo "✖ local path missing: $local_path" >&2
        return 8
    fi

    # role is constrained to MODEL|VIDEOS|LABELS|ANCHOR by the call sites;
    # constrain it here too so a future caller can't smuggle in `..` or `/`.
    case "$role" in MODEL|VIDEOS|LABELS|ANCHOR) ;;
        *) echo "✖ resolve_local_role: invalid role '$role'" >&2; return 1 ;;
    esac
    local role_lc="${role,,}"
    local stage_dir="$RESOURCES_DIR/local-$role_lc"
    # Belt-and-braces: $RESOURCES_DIR is already validated at the top of the
    # script, so $stage_dir cannot collapse to a system path. Re-assert before
    # `rm -rf` regardless — the cost is one comparison per call.
    [[ "$stage_dir" == "$RESOURCES_DIR/local-"* ]] \
        || { echo "✖ unexpected stage_dir: $stage_dir" >&2; return 1; }
    rm -rf -- "$stage_dir"
    mkdir -p "$stage_dir"
    if [[ -d "$local_path" ]]; then
        cp -r "$local_path" "$stage_dir/"
    else
        cp "$local_path" "$stage_dir/"
    fi
    local staged="$stage_dir/$(basename "$local_path")"

    local container_path="${staged/$RESOURCES_DIR/$CONTAINER_RESOURCES}"
    local label="FILE"
    [[ "$role" == "VIDEOS" ]] && label="DIR"
    # %q for eval-safety — same rationale as resolve_ngc_role above.
    printf '%s_%s_HOST=%q\n%s_%s_CONTAINER=%q\n' \
        "$role" "$label" "$staged" \
        "$role" "$label" "$container_path"
    echo "✔ $role: staged from $local_path" >&2
}

# 6. Drive every role.
if [[ "$MODEL_SOURCE" == "ngc" ]]; then
    resolve_ngc_role MODEL "$MODEL_REF" "$DEFAULT_MODEL_EXTRACT_DIR" "$DEFAULT_MODEL_PATH"
else
    resolve_local_role MODEL "$MODEL_REF"
fi

if [[ "$VIDEOS_SOURCE" == "ngc" ]]; then
    resolve_ngc_role VIDEOS "$VIDEOS_REF" "$DEFAULT_VIDEOS_EXTRACT_DIR" "$DEFAULT_VIDEOS_PATH"
else
    resolve_local_role VIDEOS "$VIDEOS_REF"
fi

# Optional warehouse-3d roles (load_defaults.sh only emits these for warehouse-3d).
if [[ -n "${DEFAULT_LABELS_NGC_REF:-}" ]]; then
    LABELS_REF="${LABELS_REF:-$DEFAULT_LABELS_NGC_REF}"
    resolve_ngc_role LABELS "$LABELS_REF" "$DEFAULT_LABELS_EXTRACT_DIR" "$DEFAULT_LABELS_PATH"
fi
if [[ -n "${DEFAULT_ANCHOR_NGC_REF:-}" ]]; then
    ANCHOR_REF="${ANCHOR_REF:-$DEFAULT_ANCHOR_NGC_REF}"
    resolve_ngc_role ANCHOR "$ANCHOR_REF" "$DEFAULT_ANCHOR_EXTRACT_DIR" "$DEFAULT_ANCHOR_PATH"
fi
