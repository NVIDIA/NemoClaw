// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { shouldRunInstallerIntegration, shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";

describe("gated E2E Vitest projects", () => {
  it("enables installer integration only in CI or with the installer opt-in env var", () => {
    expect(shouldRunInstallerIntegration({})).toBe(false);
    expect(shouldRunInstallerIntegration({ CI: "0" })).toBe(false);
    expect(shouldRunInstallerIntegration({ CI: "1" })).toBe(true);
    expect(shouldRunInstallerIntegration({ CI: "true" })).toBe(true);
    expect(shouldRunInstallerIntegration({ NEMOCLAW_RUN_INSTALLER_TESTS: "1" })).toBe(true);
  });

  it("enables live targets only by the explicit live target opt-in env var", () => {
    expect(shouldRunLiveE2E({})).toBe(false);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "0" })).toBe(false);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "yes" })).toBe(false);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "1" })).toBe(true);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "true" })).toBe(true);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: " TRUE " })).toBe(true);
  });

  it("cleans and rebuilds the CLI before aggregate live E2E execution (#6692)", () => {
    const npmCli = process.env.npm_execpath ?? "";
    expect(npmCli).not.toBe("");

    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-live-e2e-script-"));
    const fakeBin = join(fixtureRoot, "bin");
    const commandLog = join(fixtureRoot, "commands.log");
    const scriptShell = join(fixtureRoot, "script-shell");
    const npmStub = join(fakeBin, "npm");
    const vitestStub = join(fakeBin, "vitest");

    try {
      mkdirSync(fakeBin);
      writeFileSync(
        scriptShell,
        `#!/bin/sh\nPATH="$FAKE_BIN:${dirname(process.execPath)}:/usr/bin:/bin"\nexport PATH\nexec /bin/sh "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(npmStub, '#!/bin/sh\nprintf \'npm %s\\n\' "$*" >> "$COMMAND_LOG"\n', {
        mode: 0o755,
      });
      writeFileSync(
        vitestStub,
        '#!/bin/sh\nprintf \'vitest %s | live=%s\\n\' "$*" "$NEMOCLAW_RUN_LIVE_E2E" >> "$COMMAND_LOG"\n',
        { mode: 0o755 },
      );
      chmodSync(scriptShell, 0o755);
      chmodSync(npmStub, 0o755);
      chmodSync(vitestStub, 0o755);

      const result = spawnSync(process.execPath, [npmCli, "run", "test:live-e2e"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          COMMAND_LOG: commandLog,
          FAKE_BIN: fakeBin,
          npm_config_script_shell: scriptShell,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "npm run clean:cli",
        "npm run build:cli",
        "vitest run --project e2e-live | live=1",
      ]);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
