// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Model Docker socket activation while executing the helper's real shell script. */
export function runWslContainerRuntimeScript(
  script: string,
  mode: "normal" | "mask-fails" | "reachable" | "health-timeout" | "bus-unavailable" = "normal",
  initiallyMasked = false,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-runtime-"));
  try {
    if (initiallyMasked) fs.writeFileSync(path.join(directory, "masked"), "");
    const result = spawnSync(
      "bash",
      [
        "-c",
        String.raw`
systemctl() {
  printf 'systemctl %s\n' "$*" >> "$WSL_RUNTIME_FIXTURE_DIR/commands"
  case "$1" in
    mask)
      if [ "$WSL_RUNTIME_FIXTURE_MODE" = mask-fails ]; then
        echo 'systemd stop failed' >&2
        return 23
      fi
      case " $* " in
        *' --runtime '*) touch "$WSL_RUNTIME_FIXTURE_DIR/runtime-masked" ;;
        *) touch "$WSL_RUNTIME_FIXTURE_DIR/masked" ;;
      esac
      ;;
    unmask)
      rm -f "$WSL_RUNTIME_FIXTURE_DIR/runtime-masked"
      case " $* " in
        *' --runtime '*) ;;
        *) rm -f "$WSL_RUNTIME_FIXTURE_DIR/masked" ;;
      esac
      ;;
    start) test ! -f "$WSL_RUNTIME_FIXTURE_DIR/masked" && test ! -f "$WSL_RUNTIME_FIXTURE_DIR/runtime-masked" ;;
    show)
      if [ "$WSL_RUNTIME_FIXTURE_MODE" = bus-unavailable ]; then
        echo 'Failed to connect to bus: Connection refused' >&2
        return 1
      fi
      echo 'ActiveState=inactive'
      ;;
    *) return 99 ;;
  esac
}
docker() {
  printf 'docker %s\n' "$*" >> "$WSL_RUNTIME_FIXTURE_DIR/commands"
  # An unmasked socket activates Docker when a client connects.
  [ "$WSL_RUNTIME_FIXTURE_MODE" = reachable ] || {
    [ ! -f "$WSL_RUNTIME_FIXTURE_DIR/masked" ] && [ ! -f "$WSL_RUNTIME_FIXTURE_DIR/runtime-masked" ]
  }
}
simulate_wsl_restart() {
  rm -f "$WSL_RUNTIME_FIXTURE_DIR/runtime-masked"
}
timeout() {
  printf 'timeout %s\n' "$1" >> "$WSL_RUNTIME_FIXTURE_DIR/commands"
  if [ "$WSL_RUNTIME_FIXTURE_MODE" = health-timeout ]; then return 124; fi
  shift
  "$@"
}
export -f systemctl docker
` + script,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          WSL_RUNTIME_FIXTURE_DIR: directory,
          WSL_RUNTIME_FIXTURE_MODE: mode,
        },
        timeout: 5_000,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      masked:
        fs.existsSync(path.join(directory, "masked")) ||
        fs.existsSync(path.join(directory, "runtime-masked")),
      commands: fs.readFileSync(path.join(directory, "commands"), "utf8").trim().split("\n"),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
