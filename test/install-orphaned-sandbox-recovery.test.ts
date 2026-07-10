// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ORPHANED_SANDBOX_MARKER } from "../src/lib/domain/maintenance/orphan-detection";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

// The installer greps the dedicated orphan marker (emitted only for sandboxes
// absent from their OWN recorded gateway) to keep its final summary honest
// when the CLI exits 0 without recovering them (#6520). The stub line is
// built from the CLI's exported marker constant and drives the real
// install.sh grep below, so a rewording on either side fails this suite. The
// generic multi-gateway skip line must NOT trip the flag: a sandbox healthy
// on another live gateway is not an orphan.
const ORPHAN_LINE = `  1 ${ORPHANED_SANDBOX_MARKER}: my-assistant.`;
const LEGACY_SKIP_LINE =
  "  Skipping 1 sandbox(es) not observed on the selected gateway — verify their recorded gateway or start them first.";
const NO_REBUILD_LINE = "  No running stale sandboxes to rebuild.";
const REBUILT_LINE = "  ✓ 1 sandbox(es) rebuilt.";

function installerTestEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
}

function runRecoveryClassification(
  outputLines: string[],
  exitCode: number,
): { output: string; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-orphan-"));
  const outFile = path.join(tmp, "cli-output.txt");
  fs.writeFileSync(outFile, outputLines.length > 0 ? `${outputLines.join("\n")}\n` : "");
  const stubBin = path.join(tmp, "stub-cli");
  fs.writeFileSync(
    stubBin,
    `#!/usr/bin/env bash\ncat ${JSON.stringify(outFile)}\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    info() { :; }
    warn() { :; }
    _PREEXISTING_SANDBOX_COUNT=1
    recover_preexisting_sandboxes_before_onboard "${stubBin}" >/dev/null 2>&1 || true
    echo "recovery_ran=\${_PREEXISTING_SANDBOX_RECOVERY_RAN:-unset}"
    echo "orphaned=\${_PREEXISTING_SANDBOX_ORPHANED:-unset}"
    echo "failed=\${_UPGRADE_SANDBOXES_FAILED:-unset}"
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: installerTestEnv(tmp),
  });
  return {
    output: `${result.stdout}\n${result.stderr}`,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function runPrintDone(flags: { recoveryRan: string; orphaned: string }): {
  output: string;
  cleanup: () => void;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-printdone-"));
  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    needs_shell_reload() { return 1; }
    _INSTALL_START=0
    _CLI_DISPLAY="NemoClaw"
    _CLI_BIN="nemoclaw"
    ONBOARD_RAN=false
    _PREEXISTING_SANDBOX_RECOVERY_RAN=${flags.recoveryRan}
    _PREEXISTING_SANDBOX_ORPHANED=${flags.orphaned}
    _UPGRADE_SANDBOXES_FAILED=false
    print_done 2>&1
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: installerTestEnv(tmp),
  });
  return {
    output: `${result.stdout}\n${result.stderr}`,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe("install.sh recovery outcome classification (#6520)", () => {
  it("marks the run orphaned when the CLI reports sandboxes not found on their recorded gateway", () => {
    const { output, cleanup } = runRecoveryClassification([ORPHAN_LINE, NO_REBUILD_LINE], 0);
    try {
      expect(output).toContain("recovery_ran=true");
      expect(output).toContain("orphaned=true");
      expect(output).toContain("failed=false");
    } finally {
      cleanup();
    }
  });

  it("does not mark the run orphaned for the generic multi-gateway skip line", () => {
    // A sandbox bound to another live gateway prints the legacy skip line and
    // is legitimately left alone — the install summary must stay clean.
    const { output, cleanup } = runRecoveryClassification([LEGACY_SKIP_LINE, NO_REBUILD_LINE], 0);
    try {
      expect(output).toContain("recovery_ran=true");
      expect(output).toContain("orphaned=false");
    } finally {
      cleanup();
    }
  });

  it("does not mark the run orphaned when sandboxes were actually rebuilt", () => {
    const { output, cleanup } = runRecoveryClassification([REBUILT_LINE], 0);
    try {
      expect(output).toContain("recovery_ran=true");
      expect(output).toContain("orphaned=false");
    } finally {
      cleanup();
    }
  });

  it("marks the run orphaned when some sandboxes rebuilt and others were orphaned", () => {
    const { output, cleanup } = runRecoveryClassification([ORPHAN_LINE, REBUILT_LINE], 0);
    try {
      expect(output).toContain("recovery_ran=true");
      expect(output).toContain("orphaned=true");
    } finally {
      cleanup();
    }
  });

  it("still marks a non-zero recovery exit as failed, not orphaned", () => {
    const { output, cleanup } = runRecoveryClassification([], 1);
    try {
      expect(output).toContain("recovery_ran=false");
      expect(output).toContain("failed=true");
    } finally {
      cleanup();
    }
  });
});

describe("install.sh print_done honesty for orphaned sandboxes (#6520)", () => {
  it("does not claim sandboxes were recovered when recovery skipped them", () => {
    const { output, cleanup } = runPrintDone({ recoveryRan: "true", orphaned: "true" });
    try {
      expect(output).toContain("completed with warnings");
      expect(output).not.toContain("Existing sandboxes were recovered and upgraded.");
      expect(output).not.toContain("No new sandbox onboarding was needed.");
      expect(output).toContain("nemoclaw <name> destroy");
      expect(output).toContain("nemoclaw onboard");
    } finally {
      cleanup();
    }
  });

  it("keeps the recovered-and-upgraded summary when nothing was skipped", () => {
    const { output, cleanup } = runPrintDone({ recoveryRan: "true", orphaned: "false" });
    try {
      expect(output).toContain("=== Installation complete ===");
      expect(output).toContain("Existing sandboxes were recovered and upgraded.");
    } finally {
      cleanup();
    }
  });
});
