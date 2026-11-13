// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs inside the verified daemon root. Arguments permit an isolated filesystem fixture. */
export const NVIDIA_CDI_INSTALL_SCRIPT = String.raw`
set -eu
run_root=$1
toolkit=$2
owner_uid=$3
state="$run_root/nemoclaw-nvidia-cdi"
cdi="$run_root/cdi"
file="$cdi/nemoclaw-nvidia.yaml"
receipt="$state/spec.yaml"
pending=''
receipt_created=0
committed=0

fail() { printf '%s\n' "$1" >&2; exit 1; }
check_directory() {
  [ -d "$1" ] && [ ! -L "$1" ] || fail 'CDI directory is not a regular directory'
  set -- $(ls -nd "$1")
  [ "$3" = "$owner_uid" ] || fail 'CDI directory has a different owner'
  case "$1" in drwx------|drwxr-xr-x|drwx------@|drwxr-xr-x@) ;; *) fail 'CDI directory permissions are unsafe';; esac
}
has_gpu() { printf '%s\n' "$1" | grep -Fx 'nvidia.com/gpu=all' >/dev/null; }

check_directory "$run_root"
[ -x "$toolkit" ] || fail 'Bundled NVIDIA Container Toolkit is unavailable'
command -v link >/dev/null || fail 'Atomic CDI publication is unavailable'
inventory=$("$toolkit" cdi list) || fail 'Cannot inspect the existing NVIDIA CDI configuration'
if has_gpu "$inventory"; then
  printf 'NEMOCLAW_CDI_EXISTING\n'
  exit 0
fi

if [ ! -e "$state" ] && [ ! -L "$state" ]; then mkdir -m 700 "$state"; fi
check_directory "$state"
# A stale lock is an inconclusive prior operation, not permission to repeat a write.
mkdir -m 700 "$state/lock" || fail 'CDI preparation is active or interrupted; inspect its lock before retrying'
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" = 0 ] && [ "$receipt_created" = 1 ] && [ -e "$file" ]; then
    if [ ! -L "$file" ] && [ "$file" -ef "$pending" ] && cmp -s "$file" "$receipt"; then
      rm -- "$file"
    else
      printf 'CDI file changed during preparation; retained for inspection\n' >&2
      status=1
    fi
  fi
  if [ -n "$pending" ]; then rm -f -- "$pending"; fi
  if [ "$committed" = 0 ] && [ "$receipt_created" = 1 ] && [ ! -e "$file" ] && [ ! -L "$file" ]; then
    rm -f -- "$receipt"
  fi
  rmdir "$state/lock" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ ! -e "$cdi" ] && [ ! -L "$cdi" ]; then mkdir -m 755 "$cdi"; fi
check_directory "$cdi"
if [ -e "$file" ] || [ -L "$file" ] || [ -e "$receipt" ] || [ -L "$receipt" ]; then
  fail 'Prior CDI state needs inspection; no existing file was replaced'
fi

# Recheck under the lock so concurrent NemoClaw invocations do not publish duplicates.
inventory=$("$toolkit" cdi list) || fail 'Cannot recheck NVIDIA CDI configuration'
if has_gpu "$inventory"; then printf 'NEMOCLAW_CDI_EXISTING\n'; exit 0; fi
pending=$(mktemp "$cdi/.nemoclaw-nvidia.XXXXXX")
"$toolkit" cdi generate --output= --format=yaml > "$pending"
[ -s "$pending" ] || fail 'NVIDIA CDI generation returned an empty specification'
chmod 644 "$pending"
# Keep a separate comparison copy; never overwrite an operator's CDI file.
(set -C; cat "$pending" > "$receipt")
receipt_created=1
# link(2) fails if the destination exists, including a directory or symlink.
# Unlike ln's directory operand, it cannot publish inside an operator-created directory.
link "$pending" "$file"
inventory=$("$toolkit" cdi list) || fail 'Generated NVIDIA CDI configuration is invalid'
has_gpu "$inventory" || fail 'Generated NVIDIA CDI device was not discovered'
committed=1
printf 'NEMOCLAW_CDI_PREPARED\n'
`;

export const WSL_NVIDIA_CDI_PREPARE_SCRIPT = String.raw`
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
expected_id=$1
pids=''
for proc in /proc/[0-9]*; do
  if [ "$(cat "$proc/comm" 2>/dev/null || true)" = dockerd ]; then pids="$pids $(basename "$proc")"; fi
done
set -- $pids
[ "$#" = 1 ] || { printf 'Expected one Docker Desktop daemon\n' >&2; exit 1; }
root="/proc/$1/root"
# Enter the daemon filesystem before resolving /run. /var/run can be an absolute symlink.
# The engine ID binds this filesystem to the Docker endpoint selected by NemoClaw.
exec chroot "$root" /bin/sh -s -- "$expected_id" <<'NEMOCLAW_DAEMON'
set -eu
[ "$(id -u)" = 0 ] || exit 1
[ -f /var/lib/docker/engine-id ] && [ ! -L /var/lib/docker/engine-id ] || exit 1
[ "$(cat /var/lib/docker/engine-id)" = "$1" ] || { printf 'Docker daemon identity changed\n' >&2; exit 1; }
set -- /run /usr/bin/nvidia-ctk 0
${NVIDIA_CDI_INSTALL_SCRIPT}
NEMOCLAW_DAEMON
`;
