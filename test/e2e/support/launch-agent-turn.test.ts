// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { LAUNCH_TURN_SCRIPT } from "../live/launch-agent-turn.ts";

function runLaunchTurnFixture(exitStatus: number) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-turn-"));
  const scriptStub = join(fixtureRoot, "script");
  const sleepStub = join(fixtureRoot, "sleep");
  const timeoutStub = join(fixtureRoot, "timeout");

  try {
    writeFileSync(
      scriptStub,
      String.raw`#!/usr/bin/env bash
set -euo pipefail
capture=""
for argument in "$@"; do
  capture="$argument"
done
: >"$capture"
IFS= read -r -d $'\r' _
printf 'PONG\n' | tee "$capture"
IFS= read -r -d $'\r' exit_command
[[ "$exit_command" == "/exit" ]]
exit ${exitStatus}
`,
    );
    writeFileSync(sleepStub, "#!/bin/sh\n/bin/sleep 0.5\n");
    writeFileSync(timeoutStub, '#!/bin/sh\nshift 2\nexec "$@"\n');
    chmodSync(scriptStub, 0o755);
    chmodSync(sleepStub, 0o755);
    chmodSync(timeoutStub, 0o755);

    return spawnSync("bash", ["-c", LAUNCH_TURN_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_LAUNCH_COMMAND: "ignored",
        NEMOCLAW_LAUNCH_ENTRYPOINT: "",
        NEMOCLAW_LAUNCH_EXIT_COMMAND: "/exit",
        NEMOCLAW_LAUNCH_EXPECTED_REPLY: "PONG",
        NEMOCLAW_LAUNCH_PROMPT: "prompt",
        NEMOCLAW_LAUNCH_READY_TEXT: "",
        NEMOCLAW_LAUNCH_SANDBOX: "sandbox",
        PATH: `${fixtureRoot}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    });
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

it.runIf(process.platform !== "win32")(
  "waits for OpenClaw gateway readiness before sending the launch prompt (#7230)",
  () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-launch-turn-ready-"));
    const scriptStub = join(fixtureRoot, "script");
    const sleepStub = join(fixtureRoot, "sleep");
    const timeoutStub = join(fixtureRoot, "timeout");

    try {
      writeFileSync(
        scriptStub,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
capture=""
for argument in "$@"; do
  capture="$argument"
done
: >"$capture"
if IFS= read -r -t 1 -d $'\r' _; then
  echo "prompt arrived before gateway readiness" >&2
  exit 1
fi
printf 'gateway connected | idle\n' | tee -a "$capture"
IFS= read -r -d $'\r' _
printf 'PONG\n' | tee -a "$capture"
IFS= read -r -d $'\r' exit_command
[[ "$exit_command" == "/exit" ]]
exit 0
`,
      );
      writeFileSync(sleepStub, "#!/bin/sh\n/bin/sleep 0.1\n");
      writeFileSync(timeoutStub, '#!/bin/sh\nshift 2\nexec "$@"\n');
      chmodSync(scriptStub, 0o755);
      chmodSync(sleepStub, 0o755);
      chmodSync(timeoutStub, 0o755);

      const result = spawnSync("bash", ["-c", LAUNCH_TURN_SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_LAUNCH_COMMAND: "ignored",
          NEMOCLAW_LAUNCH_ENTRYPOINT: "",
          NEMOCLAW_LAUNCH_EXIT_COMMAND: "/exit",
          NEMOCLAW_LAUNCH_EXPECTED_REPLY: "PONG",
          NEMOCLAW_LAUNCH_PROMPT: "prompt",
          NEMOCLAW_LAUNCH_READY_TEXT: "gateway connected | idle",
          NEMOCLAW_LAUNCH_SANDBOX: "sandbox",
          PATH: `${fixtureRoot}:${process.env.PATH ?? ""}`,
        },
        timeout: 10_000,
      });

      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("NEMOCLAW_LAUNCH_TURN_OK");
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  },
);

it.runIf(process.platform !== "win32")(
  "records a successful reply and exit status 0 after the TUI exit command (#8584)",
  () => {
    const result = runLaunchTurnFixture(0);

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("NEMOCLAW_LAUNCH_TURN_OK");
  },
);

it.runIf(process.platform !== "win32")(
  "reports a nonzero TUI exit after recording a successful reply (#8584)",
  () => {
    const result = runLaunchTurnFixture(23);

    expect(result.signal, result.stderr).toBeNull();
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("launch exited with status 23");
    expect(result.stdout).not.toContain("NEMOCLAW_LAUNCH_TURN_OK");
  },
);
