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
  { condition: "Docker is missing", dockerInstalled: false, dockerStatus: 0, recovery: true },
  { condition: "Docker is available", dockerInstalled: true, dockerStatus: 0, recovery: false },
  { condition: "Docker is unreachable", dockerInstalled: true, dockerStatus: 1, recovery: true },
  { condition: "Docker times out", dockerInstalled: true, dockerStatus: null, recovery: true },
])(
  "preserves failed gateway removal and reports Docker availability when $condition (#11438)",
  ({ dockerInstalled, dockerStatus, recovery }) => {
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
          (command !== "docker" || dockerInstalled) && command !== "pgrep",
        env: { HOME: testHome, TMPDIR: os.tmpdir() },
        error: (line) => warnings.push(line),
        existsSync: () => false,
        isTty: false,
        log: (line) => logs.push(line),
        rmSync,
        run: (_command, args) => responses.get(args.join(" ")) ?? ok,
        runDocker: (args) => ({ ...ok, status: args[0] === "info" ? dockerStatus : 0 }),
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(warnings).toContain(
      "Could not remove gateway registration 'nemoclaw': openshell gateway remove failed (exit 1).",
    );
    const guidance = warnings.find((line) => line.startsWith("Docker is not available")) ?? "";
    expect(guidance.includes("WSL integration")).toBe(recovery);
    expect(guidance.includes("wsl --shutdown")).toBe(recovery);
    expect(guidance.includes("docker info")).toBe(recovery);
    expect(guidance.includes("rerun the same uninstall command")).toBe(recovery);
    expect(/WSL integration.*wsl --shutdown.*docker info.*rerun/s.test(guidance)).toBe(recovery);
    expect(rmSync).not.toHaveBeenCalled();
    expect(logs).not.toContain("[3/6] NemoClaw CLI");
  },
);
