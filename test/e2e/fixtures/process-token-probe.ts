// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "./clients/command.ts";

export function buildProcessTokenProbe(token: string, procRoot = "/proc"): string {
  if (token.length === 0) {
    throw new Error("process token probe requires a nonempty token");
  }
  if (token.includes("\0")) {
    throw new Error("process token probe does not accept NUL bytes");
  }

  const encodedToken = Buffer.from(token, "utf8").toString("base64");
  return `set +x
set +v
set +a
set +f
export LC_ALL=C
unset nemoclaw_process_probe_token nemoclaw_process_probe_pid nemoclaw_process_probe_root
unset nemoclaw_process_probe_path nemoclaw_process_probe_entry nemoclaw_process_probe_cmdline
command -v base64 >/dev/null 2>&1 || exit 2
command -v tr >/dev/null 2>&1 || exit 2
if ! nemoclaw_process_probe_token="$({
  printf '%s' ${shellQuote(encodedToken)} | base64 -d && printf '%s' .
})"; then
  exit 2
fi
nemoclaw_process_probe_token="\${nemoclaw_process_probe_token%.}"
nemoclaw_process_probe_pid=$$
nemoclaw_process_probe_root=${shellQuote(procRoot)}
for nemoclaw_process_probe_path in "$nemoclaw_process_probe_root"/[0-9]*/cmdline; do
  nemoclaw_process_probe_entry="\${nemoclaw_process_probe_path%/cmdline}"
  nemoclaw_process_probe_entry="\${nemoclaw_process_probe_entry##*/}"
  case "$nemoclaw_process_probe_entry" in
    ""|*[!0-9]*) continue ;;
  esac
  [ "$nemoclaw_process_probe_entry" = "$nemoclaw_process_probe_pid" ] && continue
  [ -r "$nemoclaw_process_probe_path" ] || continue
  if ! nemoclaw_process_probe_cmdline="$({ tr '\\000' '\\377' < "$nemoclaw_process_probe_path"; } 2>/dev/null)"; then
    [ -r "$nemoclaw_process_probe_path" ] || continue
    exit 2
  fi
  case "$nemoclaw_process_probe_cmdline" in
    *"$nemoclaw_process_probe_token"*)
      printf 'FOUND pid=%s\n' "$nemoclaw_process_probe_entry"
      exit 0
      ;;
  esac
done
printf '%s\n' ABSENT`;
}
