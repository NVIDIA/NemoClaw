// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { LAUNCH_TURN_SCRIPT } from "../live/launch-agent-turn.ts";

it.runIf(process.platform !== "win32")(
  "records a successful Hermes reply when the TUI closes after the first interrupt (#6006)",
  () => {
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
IFS= read -r -n 1 _
`,
      );
      writeFileSync(sleepStub, "#!/bin/sh\n/bin/sleep 0.5\n");
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
          NEMOCLAW_LAUNCH_EXPECTED_REPLY: "PONG",
          NEMOCLAW_LAUNCH_PROMPT: "prompt",
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
