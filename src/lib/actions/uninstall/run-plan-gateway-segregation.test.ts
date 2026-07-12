// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

describe("uninstall gateway-port segregation (#3053)", () => {
  it("preserves the gateways/ subtree so uninstalling one environment leaves the others", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gwpreserve-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const otherEnv = path.join(stateDir, "gateways", "8091");
      fs.mkdirSync(otherEnv, { recursive: true });
      fs.writeFileSync(path.join(otherEnv, "sandboxes.json"), "[]");
      fs.writeFileSync(path.join(stateDir, "sandboxes.json"), "[]");
      const logs: string[] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => false,
          env: {
            HOME: tmpHome,
            NEMOCLAW_NON_INTERACTIVE: "",
            NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1",
          } as NodeJS.ProcessEnv,
          existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          log: (line) => logs.push(line),
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(otherEnv, "sandboxes.json"))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps the host-shared /swapfile when other gateway-port environments remain", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-swap-"));
    try {
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(stateDir, "gateways", "8091"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "managed_swap"), "/swapfile");
      const logs: string[] = [];
      const runCalls: string[][] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command !== "docker" && command !== "pgrep",
          env: { HOME: tmpHome, NEMOCLAW_NON_INTERACTIVE: "" } as NodeJS.ProcessEnv,
          existsSync: (target) =>
            target === "/swapfile" || (target.startsWith(tmpHome) && fs.existsSync(target)),
          isTty: true,
          log: (line) => logs.push(line),
          rmSync: vi.fn(),
          run: (_command, args) => {
            runCalls.push(args);
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(logs).toContain(
        "Other NemoClaw gateway-port environments remain; keeping the host-shared /swapfile.",
      );
      expect(runCalls.some((args) => args[0] === "swapoff")).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
