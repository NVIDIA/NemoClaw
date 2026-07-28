// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

describe("DGX Station installer resume cleanup", () => {
  it("preserves pair and SSH-binding state when interactive host preflight skips onboarding", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-resume-cleanup-"));
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
pair_state="$HOME/.nemoclaw/station-dual-pair-resume.json"
binding_state="\${pair_state}.ssh-binding"
mkdir -p "$binding_state"
printf '{}\n' >"$pair_state"
printf 'binding\n' >"$binding_state/token"
printf 'resume\n' >"$HOME/.nemoclaw/station-express-resume"
_SELECTED_EXPRESS_PLATFORM='DGX Station'
ONBOARD_RAN=false
clear_station_resume_after_completed_onboarding
printf 'PAIR=%s BINDING=%s EXPRESS=%s\n' \
  "$([ -f "$pair_state" ] && printf present)" \
  "$([ -f "$binding_state/token" ] && printf present)" \
  "$([ -f "$HOME/.nemoclaw/station-express-resume" ] && printf present)"
`,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          PATH: TEST_SYSTEM_PATH,
        },
      },
    );

    try {
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain("PAIR=present BINDING=present EXPRESS=present");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
