#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

WORKSPACE_PATH="/sandbox/.openclaw/workspace"
BACKUP_BASE="${HOME}/.nemoclaw/backups"
FILES=(SOUL.md USER.md IDENTITY.md AGENTS.md MEMORY.md)
DIRS=(memory)

usage() {
    cat <<EOF
Usage:
  $(basename "$0") backup  <sandbox-name>
  $(basename "$0") restore <sandbox-name> [timestamp]

Commands:
  backup   Download workspace files from a sandbox to a timestamped local backup.
  restore  Upload workspace files from a local backup into a sandbox.
           If no timestamp is given, the most recent backup is used.

Backup location: ${BACKUP_BASE}/<timestamp>/
EOF
    exit 1
}

die() { echo "Error: $*" >&2; exit 1; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not found in PATH."
}

do_backup() {
    local sandbox="$1"
    local ts
    ts="$(date +%Y%m%d-%H%M%S)"
    local dest="${BACKUP_BASE}/${ts}"

    mkdir -p -m 0700 "$BACKUP_BASE"
    mkdir -p "$dest"
    echo "Backing up workspace from sandbox '${sandbox}'..."

    local count=0
    for f in "${FILES[@]}"; do
        if openshell sandbox download "$sandbox" "${WORKSPACE_PATH}/${f}" "${dest}/" 2>/dev/null; then
            count=$((count + 1))
        else
            echo "  Skipped ${f} (not found or download failed)"
        fi
    done

    for d in "${DIRS[@]}"; do
        if openshell sandbox download "$sandbox" "${WORKSPACE_PATH}/${d}/" "${dest}/${d}/" 2>/dev/null; then
            count=$((count + 1))
        else
            echo "  Skipped ${d}/ (not found or download failed)"
        fi
    done

    if [ "$count" -eq 0 ]; then
        rm -rf "$dest" 2>/dev/null || true
        die "No files were backed up. Check that the sandbox '${sandbox}' exists and has workspace files."
    fi

    echo "Backup saved to ${dest}/ (${count} items)"
}

do_restore() {
    local sandbox="$1"
    local ts="${2:-}"

    if [ -z "$ts" ]; then
        # Find the most recent backup
        ts="$(ls -1 "$BACKUP_BASE" 2>/dev/null | sort -r | head -n1)"
        [ -n "$ts" ] || die "No backups found in ${BACKUP_BASE}/"
        echo "Using most recent backup: ${ts}"
    fi

    local src="${BACKUP_BASE}/${ts}"
    [ -d "$src" ] || die "Backup directory not found: ${src}"

    echo "Restoring workspace to sandbox '${sandbox}' from ${src}..."

    local count=0
    for f in "${FILES[@]}"; do
        if [ -f "${src}/${f}" ]; then
            if openshell sandbox upload "$sandbox" "${src}/${f}" "${WORKSPACE_PATH}/" 2>/dev/null; then
                count=$((count + 1))
            else
                echo "  Failed to restore ${f}"
            fi
        fi
    done

    for d in "${DIRS[@]}"; do
        if [ -d "${src}/${d}" ]; then
            if openshell sandbox upload "$sandbox" "${src}/${d}/" "${WORKSPACE_PATH}/${d}/" 2>/dev/null; then
                count=$((count + 1))
            else
                echo "  Failed to restore ${d}/"
            fi
        fi
    done

    if [ "$count" -eq 0 ]; then
        die "No files were restored. Check that the sandbox '${sandbox}' is running."
    fi

    echo "Restored ${count} items to sandbox '${sandbox}'."
}

# --- Main ---

[ $# -ge 2 ] || usage
require_cmd openshell

action="$1"
sandbox="$2"
shift 2

case "$action" in
    backup)  do_backup "$sandbox" ;;
    restore) do_restore "$sandbox" "$@" ;;
    *)       usage ;;
esac
