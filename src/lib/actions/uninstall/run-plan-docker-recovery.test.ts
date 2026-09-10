// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { withProvenManagedGatewayProcess } from "../../../../test/support/uninstall-managed-gateway-test-support";
import { type RunResult, runUninstallPlan } from "./run-plan";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-docker-recovery-"));
afterAll(() => fs.rmSync(testHome, { recursive: true, force: true }));

it.each([
  { condition: "Docker is missing", dockerAvailable: false },
  { condition: "Docker is installed", dockerAvailable: true },
])(
  "preserves failed gateway removal and reports Docker availability when $condition (#11438)",
  ({ dockerAvailable }) => {
    const warnings: string[] = [];
    const logs: string[] = [];
    const rmSync = vi.fn();
    const ok: RunResult = { status: 0, stdout: "", stderr: "" };
    const responses = new Map<string, RunResult>([
      ["gateway list -o json", { ...ok, stdout: JSON.stringify([{ name: "nemoclaw" }]) }],
      ["gateway remove nemoclaw", { ...ok, status: 1 }],
    ]);
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      withProvenManagedGatewayProcess({
        isPortFree: () => true,
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          source: "packaged-service",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        }),
        commandExists: (command) =>
          (command !== "docker" || dockerAvailable) && command !== "pgrep",
        env: { HOME: testHome, TMPDIR: os.tmpdir() },
        error: (line) => warnings.push(line),
        existsSync: () => false,
        isTty: false,
        log: (line) => logs.push(line),
        rmSync,
        run: (_command, args) => responses.get(args.join(" ")) ?? ok,
        runDocker: () => ok,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(warnings).toContain(
      "Could not remove gateway registration 'nemoclaw': openshell gateway remove failed (exit 1).",
    );
    expect(warnings.filter((line) => line.startsWith("Docker is not available"))).toEqual(
      dockerAvailable
        ? []
        : [
            "Docker is not available in this shell. Restore Docker access and verify docker info. " +
              "If using Docker Desktop on Windows, enable WSL integration for this distro. " +
              "Then rerun the same uninstall command.",
          ],
    );
    expect(rmSync).not.toHaveBeenCalled();
    expect(logs).not.toContain("[3/6] NemoClaw CLI");
  },
);
