// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("Station resume sandbox name contract", () => {
  it("keeps names within the OpenShell 0.0.99 routed-name contract (#8497)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-name-"));
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
source "$INSTALLER_UNDER_TEST" >/dev/null
for sandbox in abcdefghijklmnopqrs abcdefghijklmnopqrst legacy--box; do
  if validate_station_express_resume_sandbox "$sandbox"; then
    printf '%s=valid\n' "$sandbox"
  else
    printf '%s=invalid\n' "$sandbox"
  fi
done
`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          HOME: home,
          PATH: TEST_SYSTEM_PATH,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "abcdefghijklmnopqrs=valid",
      "abcdefghijklmnopqrst=invalid",
      "legacy--box=invalid",
    ]);
  });
});
