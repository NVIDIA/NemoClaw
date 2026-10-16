// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWindowsInstallerWorkflowSources } from "../../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pwsh = process.env.NEMOCLAW_TEST_PWSH || "pwsh";
const unavailable =
  spawnSync(pwsh, ["-NoProfile", "-Command", "exit 0"], { timeout: 10_000 }).status !== 0;

function ordinaryTarget(target: string, _retained: string) {
  mkdirSync(target);
  writeFileSync(join(target, "compiler-output"), "disposable fixture bytes");
}
function linkedTarget(target: string, retained: string) {
  symlinkSync(retained, target, "junction");
}
function nestedLink(target: string, retained: string) {
  ordinaryTarget(target, retained);
  symlinkSync(retained, join(target, "linked"), "junction");
}

describe.each([
  ["openshell-target", "Build and test the pinned OpenShell host-supervisor stack"],
  ["mxc-target", "Build the pinned MXC executor and host preparation tool"],
])("completed build storage: %s", (targetName, stepName) => {
  it.skipIf(unavailable).each([
    { scenario: "completed", arrange: ordinaryTarget, wrongRoot: false, exit: 0, retained: false },
    { scenario: "wrong-root", arrange: ordinaryTarget, wrongRoot: true, exit: 1, retained: true },
    { scenario: "target-link", arrange: linkedTarget, wrongRoot: false, exit: 1, retained: true },
    { scenario: "nested-link", arrange: nestedLink, wrongRoot: false, exit: 1, retained: true },
  ])("reclaims only the owned target: $scenario", (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "finished-build-cleanup-"));
    const target = join(root, "finished-windows", targetName);
    const retained = join(root, "retained");
    try {
      mkdirSync(retained, { recursive: true });
      writeFileSync(join(retained, "verified.exe"), "retained fixture bytes");
      mkdirSync(join(root, "finished-windows"), { recursive: true });
      scenario.arrange(target, retained);
      const workflow = readWindowsInstallerWorkflowSources(repoRoot).workflow;
      const run = workflow.jobs["windows-finished-installer"].steps!.find(
        (item) => item.name === stepName,
      )!.run!;
      const cleanupStart = run.lastIndexOf("\n$completedCargoTarget =");
      expect(cleanupStart).toBeGreaterThan(0);
      const cleanup = run.slice(cleanupStart);
      const result = spawnSync(
        pwsh,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // Match the parameter attributes left by dot-sourcing windows-msvc.ps1.
          `$ErrorActionPreference = 'Stop'
. { param([ValidateSet('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc', 'native', 'all')][string] $Target) } 'aarch64-pc-windows-msvc'
${cleanup}
if ($Target -cne 'aarch64-pc-windows-msvc') { throw 'Build target parameter was overwritten.' }`,
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            CARGO_TARGET_DIR: scenario.wrongRoot ? retained : target,
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(scenario.exit);
      expect(result.stderr).not.toContain("MetadataError");
      expect(readFileSync(join(retained, "verified.exe"), "utf8")).toBe("retained fixture bytes");
      expect(existsSync(target)).toBe(scenario.retained);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
