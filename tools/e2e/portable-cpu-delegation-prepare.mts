// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTABLE_CPU_DELEGATION_PREPARE_SCRIPT = `set -euo pipefail
drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"
drop_in_dir="$(dirname "$drop_in")"
drop_in_marker="$RUNNER_TEMP/nemoclaw-cpu-delegation-drop-in-created"
drop_in_dir_marker="$RUNNER_TEMP/nemoclaw-cpu-delegation-drop-in-dir-created"
app_slice_drop_in="/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf"
app_slice_drop_in_dir="$(dirname "$app_slice_drop_in")"
app_slice_drop_in_marker="$RUNNER_TEMP/nemoclaw-app-slice-drop-in-created"
app_slice_drop_in_dir_marker="$RUNNER_TEMP/nemoclaw-app-slice-drop-in-dir-created"
slice_drop_in_marker="$RUNNER_TEMP/nemoclaw-cpu-slice-drop-in-created"
slice_drop_in_dir_marker="$RUNNER_TEMP/nemoclaw-cpu-slice-drop-in-dir-created"
source_cache_marker="$RUNNER_TEMP/nemoclaw-source-require-cache-created"
workspace_traverse_marker="$RUNNER_TEMP/nemoclaw-workspace-traverse-modes"
user_comment="nemoclaw-cpu-proof-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"
uid=""
created_user=0
drop_in_temp=""
drop_in_id=""
drop_in_dir_id=""
app_slice_drop_in_temp=""
app_slice_drop_in_id=""
created_app_slice_drop_in_dir=0
app_slice_drop_in_dir_id=""
slice_drop_in_dir=""
slice_drop_in=""
slice_drop_in_temp=""
slice_drop_in_id=""
created_slice_drop_in_dir=0
slice_drop_in_dir_id=""
source_cache_parent="$GITHUB_WORKSPACE/node_modules/.cache"
source_cache_dir="$source_cache_parent/nemoclaw-source-require"
source_cache_id=""

cleanup_failed_prepare() {
  local status=$?
  local current_drop_in_id=""
  local current_app_slice_drop_in_id=""
  local current_slice_drop_in_id=""
  local current_source_cache_id=""
  local cleanup_failed=0
  trap - EXIT
  set +e
  if [ "$created_user" = 1 ] && id "$E2E_CPU_DELEGATION_USER" >/dev/null 2>&1; then
    if [ -n "$uid" ]; then
      sudo systemctl stop "user@\${uid}.service" || cleanup_failed=1
    fi
  fi
  if [ -n "$slice_drop_in_temp" ]; then
    sudo rm -f -- "$slice_drop_in_temp" || cleanup_failed=1
  fi
  if [ -n "$drop_in_temp" ]; then
    sudo rm -f -- "$drop_in_temp" || cleanup_failed=1
  fi
  if [ -n "$app_slice_drop_in_temp" ]; then
    sudo rm -f -- "$app_slice_drop_in_temp" || cleanup_failed=1
  fi
  if [ -n "$source_cache_id" ]; then
    current_source_cache_id="$(sudo stat -Lc '%d:%i' -- "$source_cache_dir" 2>/dev/null)"
    if [ "$current_source_cache_id" = "$source_cache_id" ]; then
      sudo rm -rf --one-file-system -- "$source_cache_dir" || cleanup_failed=1
    elif sudo test -e "$source_cache_dir" || sudo test -L "$source_cache_dir"; then
      echo "::error::Refusing to remove a source-loader cache whose identity changed" >&2
      cleanup_failed=1
    fi
  fi
  if [ -n "$drop_in_id" ]; then
    current_drop_in_id="$(sudo stat -Lc '%d:%i' -- "$drop_in" 2>/dev/null)"
    if [ "$current_drop_in_id" = "$drop_in_id" ]; then
      sudo rm -f -- "$drop_in" || cleanup_failed=1
    elif sudo test -e "$drop_in" || sudo test -L "$drop_in"; then
      echo "::error::Refusing to remove a CPU delegation drop-in whose identity changed" >&2
      cleanup_failed=1
    fi
  fi
  if [ -n "$app_slice_drop_in_id" ]; then
    current_app_slice_drop_in_id="$(
      sudo stat -Lc '%d:%i' -- "$app_slice_drop_in" 2>/dev/null
    )"
    if [ "$current_app_slice_drop_in_id" = "$app_slice_drop_in_id" ]; then
      sudo rm -f -- "$app_slice_drop_in" || cleanup_failed=1
    elif sudo test -e "$app_slice_drop_in" \\
      || sudo test -L "$app_slice_drop_in"; then
      echo "::error::Refusing to remove an app.slice proof drop-in whose identity changed" >&2
      cleanup_failed=1
    fi
  fi
  if [ -n "$slice_drop_in_id" ]; then
    current_slice_drop_in_id="$(sudo stat -Lc '%d:%i' -- "$slice_drop_in" 2>/dev/null)"
    if [ "$current_slice_drop_in_id" = "$slice_drop_in_id" ]; then
      sudo rm -f -- "$slice_drop_in" || cleanup_failed=1
    elif sudo test -e "$slice_drop_in" || sudo test -L "$slice_drop_in"; then
      echo "::error::Refusing to remove a CPU slice drop-in whose identity changed" >&2
      cleanup_failed=1
    fi
  fi
  if [ -n "$drop_in_id" ] || [ -n "$slice_drop_in_id" ]; then
    sudo systemctl daemon-reload || cleanup_failed=1
  fi
  if [ "$created_app_slice_drop_in_dir" = 1 ] \\
    && [ "$(sudo stat -Lc '%d:%i' -- "$app_slice_drop_in_dir" 2>/dev/null)" \\
      = "$app_slice_drop_in_dir_id" ]; then
    sudo rmdir -- "$app_slice_drop_in_dir" || cleanup_failed=1
  fi
  if [ "$created_slice_drop_in_dir" = 1 ] && [ -n "$slice_drop_in_dir" ] \\
    && [ "$(sudo stat -Lc '%d:%i' -- "$slice_drop_in_dir" 2>/dev/null)" \\
      = "$slice_drop_in_dir_id" ]; then
    sudo rmdir -- "$slice_drop_in_dir" || cleanup_failed=1
  fi
  if [ -n "$drop_in_dir_id" ] \\
    && [ "$(sudo stat -Lc '%d:%i' -- "$drop_in_dir" 2>/dev/null)" \\
      = "$drop_in_dir_id" ]; then
    sudo rmdir -- "$drop_in_dir" || cleanup_failed=1
  fi
  if [ "$created_user" = 1 ] && id "$E2E_CPU_DELEGATION_USER" >/dev/null 2>&1; then
    current_user_comment="$(
      getent passwd "$E2E_CPU_DELEGATION_USER" | cut -d: -f5
    )"
    if [ "$current_user_comment" = "$user_comment" ]; then
      sudo loginctl disable-linger "$E2E_CPU_DELEGATION_USER" || cleanup_failed=1
      sudo loginctl terminate-user "$E2E_CPU_DELEGATION_USER" || true
      sudo userdel --remove "$E2E_CPU_DELEGATION_USER" || cleanup_failed=1
    else
      echo "::error::Refusing preparation rollback for a proof user whose ownership comment changed" >&2
      cleanup_failed=1
    fi
  fi
  if [ -e "$workspace_traverse_marker" ]; then
    workspace_restore_failed=0
    while IFS=$'\\t' read -r original_mode workspace_path; do
      if ! sudo chmod "$original_mode" -- "$workspace_path"; then
        workspace_restore_failed=1
        cleanup_failed=1
      fi
    done <"$workspace_traverse_marker"
    if [ "$workspace_restore_failed" = 0 ]; then
      rm -f -- "$workspace_traverse_marker" || cleanup_failed=1
    else
      echo "::error::Preserving the workspace mode receipt for final cleanup retry" >&2
    fi
  fi
  if [ "$cleanup_failed" != 0 ]; then
    echo "::error::Preparation rollback was incomplete; final cleanup will retry recorded resources" >&2
  fi
  exit "$status"
}
trap cleanup_failed_prepare EXIT

{
  printf 'E2E_CPU_DELEGATION_USER_CLAIMED=1\\n'
  printf 'E2E_CPU_DELEGATION_USER_COMMENT=%s\\n' "$user_comment"
  printf 'E2E_CPU_DELEGATION_USER_CREATED=0\\n'
  printf 'E2E_CPU_DELEGATION_DROP_IN_DIR=%s\\n' "$drop_in_dir"
  printf 'E2E_CPU_DELEGATION_DROP_IN_DIR_MARKER=%s\\n' "$drop_in_dir_marker"
  printf 'E2E_CPU_DELEGATION_DROP_IN_MARKER=%s\\n' "$drop_in_marker"
  printf 'E2E_APP_SLICE_DROP_IN=%s\\n' "$app_slice_drop_in"
  printf 'E2E_APP_SLICE_DROP_IN_DIR=%s\\n' "$app_slice_drop_in_dir"
  printf 'E2E_APP_SLICE_DROP_IN_DIR_CREATED=0\\n'
  printf 'E2E_APP_SLICE_DROP_IN_DIR_MARKER=%s\\n' "$app_slice_drop_in_dir_marker"
  printf 'E2E_APP_SLICE_DROP_IN_MARKER=%s\\n' "$app_slice_drop_in_marker"
  printf 'E2E_CPU_SLICE_DROP_IN_MARKER=%s\\n' "$slice_drop_in_marker"
  printf 'E2E_CPU_SLICE_DROP_IN_DIR_CREATED=0\\n'
  printf 'E2E_CPU_SLICE_DROP_IN_DIR_MARKER=%s\\n' "$slice_drop_in_dir_marker"
  printf 'E2E_SOURCE_CACHE_DIR=%s\\n' "$source_cache_dir"
  printf 'E2E_SOURCE_CACHE_MARKER=%s\\n' "$source_cache_marker"
  printf 'E2E_WORKSPACE_TRAVERSE_MARKER=%s\\n' "$workspace_traverse_marker"
} >>"$GITHUB_ENV"
if id "$E2E_CPU_DELEGATION_USER" >/dev/null 2>&1; then
  echo "::error::CPU delegation proof user already exists" >&2
  exit 1
fi
if sudo test -e "$drop_in" || sudo test -L "$drop_in"; then
  echo "::error::CPU delegation proof drop-in already exists" >&2
  exit 1
fi
if [ -e "$drop_in_marker" ] || [ -L "$drop_in_marker" ]; then
  echo "::error::CPU delegation proof ownership marker already exists" >&2
  exit 1
fi
if [ -e "$drop_in_dir_marker" ] || [ -L "$drop_in_dir_marker" ]; then
  echo "::error::CPU delegation drop-in directory marker already exists" >&2
  exit 1
fi
if sudo test -e "$app_slice_drop_in" || sudo test -L "$app_slice_drop_in"; then
  echo "::error::app.slice proof drop-in already exists" >&2
  exit 1
fi
if [ -e "$app_slice_drop_in_marker" ] || [ -L "$app_slice_drop_in_marker" ]; then
  echo "::error::app.slice proof ownership marker already exists" >&2
  exit 1
fi
if [ -e "$app_slice_drop_in_dir_marker" ] \\
  || [ -L "$app_slice_drop_in_dir_marker" ]; then
  echo "::error::app.slice drop-in directory marker already exists" >&2
  exit 1
fi
if [ -e "$slice_drop_in_marker" ] || [ -L "$slice_drop_in_marker" ]; then
  echo "::error::CPU slice proof ownership marker already exists" >&2
  exit 1
fi
if [ -e "$slice_drop_in_dir_marker" ] || [ -L "$slice_drop_in_dir_marker" ]; then
  echo "::error::CPU slice drop-in directory marker already exists" >&2
  exit 1
fi
if [ -e "$source_cache_marker" ] || [ -L "$source_cache_marker" ]; then
  echo "::error::Source-loader cache ownership marker already exists" >&2
  exit 1
fi
if [ -e "$workspace_traverse_marker" ] || [ -L "$workspace_traverse_marker" ]; then
  echo "::error::Workspace traversal ownership marker already exists" >&2
  exit 1
fi
sudo useradd --create-home --shell /bin/bash --comment "$user_comment" \\
  "$E2E_CPU_DELEGATION_USER"
created_user=1
printf 'E2E_CPU_DELEGATION_USER_CREATED=1\\n' >>"$GITHUB_ENV"
uid="$(id -u "$E2E_CPU_DELEGATION_USER")"
home="$(getent passwd "$E2E_CPU_DELEGATION_USER" | cut -d: -f6)"
slice_drop_in_dir="/etc/systemd/system/user-\${uid}.slice.d"
slice_drop_in="$slice_drop_in_dir/90-nemoclaw-cpu-controller.conf"
{
  printf 'E2E_CPU_DELEGATION_HOME=%s\\n' "$home"
  printf 'E2E_CPU_DELEGATION_UID=%s\\n' "$uid"
  printf 'E2E_CPU_DELEGATION_RUNTIME_DIR=/run/user/%s\\n' "$uid"
  printf 'E2E_CPU_SLICE_DROP_IN=%s\\n' "$slice_drop_in"
  printf 'E2E_CPU_SLICE_DROP_IN_DIR=%s\\n' "$slice_drop_in_dir"
} >>"$GITHUB_ENV"
workspace_path="$GITHUB_WORKSPACE"
workspace_ancestors=()
while [ "$workspace_path" != "/" ]; do
  workspace_ancestors+=("$workspace_path")
  workspace_path="$(dirname "$workspace_path")"
done
: >"$workspace_traverse_marker"
chmod 0600 "$workspace_traverse_marker"
for ((index = \${#workspace_ancestors[@]} - 1; index >= 0; index--)); do
  workspace_path="\${workspace_ancestors[$index]}"
  if ! sudo --user "$E2E_CPU_DELEGATION_USER" test -x "$workspace_path"; then
    original_mode="$(stat -c '%a' -- "$workspace_path")"
    printf '%s\\t%s\\n' "$original_mode" "$workspace_path" \\
      >>"$workspace_traverse_marker"
    sudo chmod o+x -- "$workspace_path"
  fi
done
if ! sudo --user "$E2E_CPU_DELEGATION_USER" \\
  test -x "$GITHUB_WORKSPACE/node_modules/.bin/vitest"; then
  echo "::error::Dedicated proof user cannot execute the Vitest entrypoint" >&2
  namei -l "$GITHUB_WORKSPACE/node_modules/.bin/vitest" >&2 || true
  exit 1
fi
if [ -L "$source_cache_parent" ] \\
  || { [ -e "$source_cache_parent" ] && [ ! -d "$source_cache_parent" ]; }; then
  echo "::error::Source-loader cache parent has an unexpected type" >&2
  exit 1
fi
if [ ! -d "$source_cache_parent" ]; then
  install -d -m 0755 -- "$source_cache_parent"
fi
if ! sudo --user "$E2E_CPU_DELEGATION_USER" test -x "$source_cache_parent"; then
  echo "::error::Dedicated proof user cannot traverse the source-loader cache parent" >&2
  exit 1
fi
if sudo test -e "$source_cache_dir" || sudo test -L "$source_cache_dir"; then
  echo "::error::Source-loader cache already exists" >&2
  exit 1
fi
sudo mkdir -m 0700 -- "$source_cache_dir"
source_cache_id="$(sudo stat -Lc '%d:%i' -- "$source_cache_dir")"
printf '%s\\n' "$source_cache_id" >"$source_cache_marker"
sudo chown "$uid:$uid" -- "$source_cache_dir"
sudo install -d -o "$uid" -g "$uid" -m 0700 "$E2E_ARTIFACT_DIR"
if sudo test -e "$slice_drop_in" || sudo test -L "$slice_drop_in"; then
  echo "::error::CPU slice proof drop-in already exists" >&2
  exit 1
fi
if sudo test -L "$slice_drop_in_dir" \\
  || { sudo test -e "$slice_drop_in_dir" && ! sudo test -d "$slice_drop_in_dir"; }; then
  echo "::error::CPU slice proof drop-in directory has an unexpected type" >&2
  exit 1
fi
if ! sudo test -d "$slice_drop_in_dir"; then
  created_slice_drop_in_dir=1
  sudo mkdir -m 0755 -- "$slice_drop_in_dir"
  slice_drop_in_dir_id="$(sudo stat -Lc '%d:%i' -- "$slice_drop_in_dir")"
  printf '%s\\n' "$slice_drop_in_dir_id" >"$slice_drop_in_dir_marker"
  printf 'E2E_CPU_SLICE_DROP_IN_DIR_CREATED=1\\n' >>"$GITHUB_ENV"
fi
if [ "$(sudo stat -Lc '%U:%G %a' -- "$slice_drop_in_dir")" != "root:root 755" ]; then
  echo "::error::CPU slice proof drop-in directory has unexpected owner or mode" >&2
  exit 1
fi
slice_drop_in_temp="$(sudo mktemp "$slice_drop_in_dir/.nemoclaw-cpu-controller.XXXXXX")"
# CPU accounting alone does not activate the CPU controller on cgroup v2.
# An explicit default CPU weight does, without changing relative weight.
printf '[Slice]\\nCPUWeight=100\\n' | sudo tee "$slice_drop_in_temp" >/dev/null
sudo chown root:root "$slice_drop_in_temp"
sudo chmod 0644 "$slice_drop_in_temp"
slice_drop_in_id="$(sudo stat -Lc '%d:%i' -- "$slice_drop_in_temp")"
sudo ln -- "$slice_drop_in_temp" "$slice_drop_in"
sudo rm -f -- "$slice_drop_in_temp"
slice_drop_in_temp=""
printf '%s\\n' "$slice_drop_in_id" >"$slice_drop_in_marker"

if sudo test -L "$app_slice_drop_in_dir" \\
  || { sudo test -e "$app_slice_drop_in_dir" \\
    && ! sudo test -d "$app_slice_drop_in_dir"; }; then
  echo "::error::app.slice proof drop-in directory has an unexpected type" >&2
  exit 1
fi
if ! sudo test -d "$app_slice_drop_in_dir"; then
  created_app_slice_drop_in_dir=1
  sudo mkdir -m 0755 -- "$app_slice_drop_in_dir"
  app_slice_drop_in_dir_id="$(
    sudo stat -Lc '%d:%i' -- "$app_slice_drop_in_dir"
  )"
  printf '%s\\n' "$app_slice_drop_in_dir_id" >"$app_slice_drop_in_dir_marker"
  printf 'E2E_APP_SLICE_DROP_IN_DIR_CREATED=1\\n' >>"$GITHUB_ENV"
fi
if [ "$(sudo stat -Lc '%U:%G %a' -- "$app_slice_drop_in_dir")" \\
  != "root:root 755" ]; then
  echo "::error::app.slice proof drop-in directory has unexpected owner or mode" >&2
  exit 1
fi
app_slice_drop_in_temp="$(
  sudo mktemp "$app_slice_drop_in_dir/.nemoclaw-cpu-controller.XXXXXX"
)"
# The user manager enables delegated controllers for user units that request them.
printf '[Slice]\\nCPUWeight=100\\n' | sudo tee "$app_slice_drop_in_temp" >/dev/null
sudo chown root:root "$app_slice_drop_in_temp"
sudo chmod 0644 "$app_slice_drop_in_temp"
app_slice_drop_in_id="$(sudo stat -Lc '%d:%i' -- "$app_slice_drop_in_temp")"
sudo ln -- "$app_slice_drop_in_temp" "$app_slice_drop_in"
sudo rm -f -- "$app_slice_drop_in_temp"
app_slice_drop_in_temp=""
printf '%s\\n' "$app_slice_drop_in_id" >"$app_slice_drop_in_marker"

if sudo test -L "$drop_in_dir" \\
  || { sudo test -e "$drop_in_dir" && ! sudo test -d "$drop_in_dir"; }; then
  echo "::error::CPU delegation proof drop-in directory has an unexpected type" >&2
  exit 1
fi
if ! sudo test -d "$drop_in_dir"; then
  sudo mkdir -m 0755 -- "$drop_in_dir"
  drop_in_dir_id="$(sudo stat -Lc '%d:%i' -- "$drop_in_dir")"
  printf '%s\\n' "$drop_in_dir_id" >"$drop_in_dir_marker"
fi
if [ "$(sudo stat -Lc '%U:%G %a' -- "$drop_in_dir")" != "root:root 755" ]; then
  echo "::error::CPU delegation proof drop-in directory has unexpected owner or mode" >&2
  exit 1
fi
drop_in_temp="$(sudo mktemp "$drop_in_dir/.nemoclaw-cpu-delegation.XXXXXX")"
printf '[Service]\\nDelegate=memory pids\\n' | sudo tee "$drop_in_temp" >/dev/null
sudo chown root:root "$drop_in_temp"
sudo chmod 0644 "$drop_in_temp"
drop_in_id="$(sudo stat -Lc '%d:%i' -- "$drop_in_temp")"
sudo ln -- "$drop_in_temp" "$drop_in"
sudo rm -f -- "$drop_in_temp"
drop_in_temp=""
printf '%s\\n' "$drop_in_id" >"$drop_in_marker"
sudo systemctl daemon-reload
sudo loginctl enable-linger "$E2E_CPU_DELEGATION_USER"
if ! sudo systemctl start "user@\${uid}.service"; then
  {
    sudo systemctl --no-pager --full status "user@\${uid}.service" || true
    sudo journalctl --no-pager --unit "user@\${uid}.service" --lines 200 || true
  } 2>&1 | python3 test/e2e/lib/redact-text.py | sudo tee \\
    "$E2E_ARTIFACT_DIR/prepare-user-manager-diagnostics.txt" >/dev/null
  exit 1
fi
user_slice_controllers="/sys/fs/cgroup/user.slice/user-\${uid}.slice/cgroup.controllers"
if ! grep -qw cpu "$user_slice_controllers"; then
  echo "::error::dedicated proof user slice does not expose the CPU controller" >&2
  cat "$user_slice_controllers" >&2 || true
  exit 1
fi
trap - EXIT

`;

export function runPortableCpuDelegationPrepare(): void {
  const result = spawnSync("bash", ["-c", PORTABLE_CPU_DELEGATION_PREPARE_SCRIPT], {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`CPU delegation preparation terminated with signal ${result.signal}`);
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPortableCpuDelegationPrepare();
}
