// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The container filesystem survives an automatic restart, unlike a tmpfs mount.
export const VLLM_STARTUP_LOG_HISTORY_SCRIPT = `
set -eu
if [ ! -f .first-attempt ]; then
  touch .first-attempt
  printf '%s\n' 'vllm: error: unrecognized arguments: --disable-log-requests' >&2
  exit 1
fi
i=0
while [ "$i" -lt 79 ]; do
  printf 'Requirement already satisfied: package-%s\n' "$i"
  i=$((i + 1))
done
printf '%s\n' "WARNING: Running pip as the 'root' user" >&2
`;
