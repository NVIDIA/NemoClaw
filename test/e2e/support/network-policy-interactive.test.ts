// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  POLICY_ADD_EXPECT_SCRIPT,
  runInteractivePolicyAdd,
} from "../live/network-policy-interactive.ts";

describe("network-policy interactive preset harness", () => {
  it("passes the preset-picker inputs to Expect (#9045)", async () => {
    const result = {
      artifacts: { result: "result.json", stderr: "stderr.txt", stdout: "stdout.txt" },
      command: ["expect"],
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "",
      timedOut: false,
    };
    const command = vi.fn().mockResolvedValue(result);

    await expect(
      runInteractivePolicyAdd(
        { command },
        {
          artifactName: "policy-add-slack-interactive",
          cliEntrypoint: "/repo/dist/cli.js",
          env: { PATH: "/usr/bin" },
          preset: "slack",
          sandboxName: "e2e-net-policy",
          timeoutMs: 120_000,
        },
      ),
    ).resolves.toBe(result);

    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith("expect", ["-c", POLICY_ADD_EXPECT_SCRIPT], {
      artifactName: "policy-add-slack-interactive",
      env: {
        PATH: "/usr/bin",
        NEMOCLAW_E2E_CLI: "/repo/dist/cli.js",
        NEMOCLAW_E2E_PRESET: "slack",
        NEMOCLAW_E2E_SANDBOX: "e2e-net-policy",
      },
      timeoutMs: 120_000,
    });
  });

  const expectAvailable =
    spawnSync("expect", ["-v"], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 5_000,
    }).status === 0;
  const fixtureDir = mkdtempSync(join(tmpdir(), "nemoclaw-policy-add-pty-"));
  const fixtureCli = join(fixtureDir, "fake-policy-add.mjs");
  writeFileSync(
    fixtureCli,
    `import { createInterface } from "node:readline/promises";
import process from "node:process";

if (!process.stdin.isTTY || !process.stderr.isTTY) {
  console.error("policy picker requires a terminal");
  process.exit(20);
}

const prompts = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
process.stderr.write("\\n  Available presets:\\n");
process.stderr.write("    14) ○ hermes-slack — unrelated prefix\\n");
process.stderr.write("    15) ○ slack — Slack API access\\n");
process.stderr.write("    16) ● pypi — Python Package Index\\n\\n");
const preset = await prompts.question("  Choose preset [14]: ");
if (preset.trim() !== "15") {
  console.error("unexpected preset selection: " + preset);
  process.exit(21);
}
const confirmation = await prompts.question("  Apply 'slack'? [Y/n]: ");
if (confirmation.trim() !== "Y") {
  console.error("unexpected confirmation: " + confirmation);
  process.exit(22);
}
prompts.close();
console.log("FAKE_POLICY_ADD_OK");
`,
    "utf8",
  );
  afterAll(() => rmSync(fixtureDir, { force: true, recursive: true }));

  describe.runIf(expectAvailable)("Expect pseudo-terminal behavior", () => {
    function runExpect(preset: string) {
      return spawnSync("expect", ["-c", POLICY_ADD_EXPECT_SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_E2E_CLI: fixtureCli,
          NEMOCLAW_E2E_PRESET: preset,
          NEMOCLAW_E2E_SANDBOX: "e2e-net-policy",
        },
        killSignal: "SIGKILL",
        timeout: 5_000,
      });
    }

    it("selects the exact preset when the picker rejects input without a terminal (#9045)", () => {
      const noTerminal = spawnSync(process.execPath, [fixtureCli], {
        encoding: "utf8",
        input: "15\\nY\\n",
        killSignal: "SIGKILL",
        timeout: 5_000,
      });
      expect(noTerminal.status, noTerminal.stderr).toBe(20);

      const result = runExpect("slack");
      expect(result.status, `${result.stdout}\\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("FAKE_POLICY_ADD_OK");
    });

    it("rejects a preset that the rendered menu does not contain (#9045)", () => {
      const result = runExpect("missing");

      expect(result.status, `${result.stdout}\\n${result.stderr}`).toBe(7);
      expect(result.stderr).toContain(
        "requested policy preset was not present in the interactive menu",
      );
      expect(result.stdout).not.toContain("FAKE_POLICY_ADD_OK");
    });
  });
});
