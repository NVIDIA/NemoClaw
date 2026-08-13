// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan } from "./run-plan";

const HOST_GATEWAY_PID = 9999043;

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function uninstallWithHostGatewayOwnedBy(uid: number): {
  errors: string[];
  exitCode: number;
} {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-foreign-"));
  const errors: string[] = [];
  const psResults = new Map<string, RunResult>([
    ["stat=", ok("S\n")],
    ["args=", ok("/usr/local/bin/openshell-gateway\n")],
    ["user=", ok("otheruser\n")],
    ["uid=", ok(`${uid}\n`)],
  ]);
  const run = (command: string, args: string[]): RunResult =>
    command === "pgrep"
      ? args.some((arg) => arg.includes("openshell-gateway"))
        ? ok(`${HOST_GATEWAY_PID}\n`)
        : notFound()
      : command === "ps"
        ? (psResults.get(args.at(-1) ?? "") ?? notFound())
        : command === "openshell" && args.join(" ") === "gateway list -o json"
          ? ok("[]")
          : ok();
  try {
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        commandExists: (command) => command === "pgrep" || command === "openshell",
        env: { HOME: tmpHome, NO_COLOR: "1" },
        error: (message) => errors.push(message),
        existsSync: () => false,
        isTty: false,
        kill: () => false,
        log: vi.fn(),
        requireCompleteGatewayProcessCleanup: true,
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        }),
        rmSync: vi.fn(),
        run,
        runDocker: () => ok(),
      },
    );
    return { errors, exitCode: result.exitCode };
  } finally {
    fs.rmSync(tmpHome, { force: true, recursive: true });
  }
}

describe("uninstall with a host gateway owned by another user", () => {
  it("completes when the only unstoppable gateway process belongs to another user", () => {
    const { errors, exitCode } = uninstallWithHostGatewayOwnedBy((process.getuid?.() ?? 0) + 1);

    expect(exitCode).toBe(0);
    expect(errors).toContainEqual(
      `Kept otheruser-owned host openshell-gateway process ${HOST_GATEWAY_PID} running. ` +
        "Cleanup does not stop a gateway process that another user owns.",
    );
    expect(errors).not.toContainEqual(
      "Cannot continue uninstall because host gateway process cleanup did not complete.",
    );
  });

  it("still fails when the current user's own gateway process cannot be stopped", () => {
    const { errors, exitCode } = uninstallWithHostGatewayOwnedBy(process.getuid?.() ?? 0);

    expect(exitCode).toBe(1);
    expect(errors).toContainEqual(
      "Cannot continue uninstall because host gateway process cleanup did not complete.",
    );
  });
});
