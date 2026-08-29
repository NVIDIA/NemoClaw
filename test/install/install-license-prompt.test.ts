// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runUsageNoticePrompt(answer: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-license-prompt-"));
  tempRoots.push(home);
  const result = spawnSync(
    "bash",
    ["-c", 'source "$INSTALLER_UNDER_TEST"; show_usage_notice_shell'],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
        PATH: TEST_SYSTEM_PATH,
      },
      input: answer,
    },
  );
  return {
    result,
    stateExists: fs.existsSync(path.join(home, ".nemoclaw", "usage-notice.json")),
  };
}

describe("installer third-party software acceptance prompt", () => {
  it("does not accept a bare y when the re-prompt reaches EOF (#7469)", () => {
    const { result, stateExists } = runUsageNoticePrompt("y\n");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Did you mean 'yes'?");
    expect(output).toContain("Installation cancelled");
    expect(stateExists).toBe(false);
  });

  it("re-prompts after a bare y and accepts only a subsequent yes (#7469)", () => {
    const { result, stateExists } = runUsageNoticePrompt("y\nyes\n");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("Did you mean 'yes'?");
    expect(output.match(/Type 'yes'/g)).toHaveLength(2);
    expect(output).not.toContain("Installation cancelled");
    expect(stateExists).toBe(true);
  });
});
