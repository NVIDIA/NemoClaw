// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

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
          rmSync: fs.rmSync,
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
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes managed swap when the selected non-default port is the final environment", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-final-port-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const selectedEnv = path.join(stateDir, "gateways", String(port));
      fs.mkdirSync(selectedEnv, { recursive: true });
      fs.mkdirSync(path.join(stateDir, "backups"));
      fs.writeFileSync(path.join(stateDir, "sandboxes.json"), "[]");
      fs.writeFileSync(path.join(stateDir, "managed_swap"), "/swapfile");
      const defaultSession = path.join(stateDir, "onboard-session.json");
      fs.writeFileSync(defaultSession, "{}");
      const runCalls: string[][] = [];

      const deps = {
        commandExists: (command: string) => command !== "docker" && command !== "pgrep",
        env: {
          HOME: tmpHome,
          NEMOCLAW_GATEWAY_PORT: String(port),
          NEMOCLAW_NON_INTERACTIVE: "",
        } as NodeJS.ProcessEnv,
        existsSync: (target: string) =>
          target === "/swapfile" || (target.startsWith(tmpHome) && fs.existsSync(target)),
        isTty: true,
        log: vi.fn(),
        rmSync: fs.rmSync,
        run: (_command: string, args: string[]) => {
          runCalls.push(args);
          return ok();
        },
        runDocker: () => ok(""),
      };
      const options = { assumeYes: true, deleteModels: false, keepOpenShell: true };

      const protectedResult = runPortUninstall(options, deps);
      expect(protectedResult.exitCode).toBe(0);
      expect(runCalls.some((args) => args[0] === "swapoff")).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(true);

      fs.rmSync(defaultSession);
      fs.mkdirSync(selectedEnv, { recursive: true });
      runCalls.length = 0;
      const result = runPortUninstall(options, deps);

      expect(result.exitCode).toBe(0);
      expect(runCalls).toContainEqual(["swapoff", "/swapfile"]);
      expect(runCalls).toContainEqual(["rm", "-f", "/swapfile"]);
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(false);
      expect(fs.existsSync(selectedEnv)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("keeps managed swap when a sibling non-default port remains", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-sibling-port-"));
    const port = 9123;
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
      vi.resetModules();
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const selectedEnv = path.join(stateDir, "gateways", String(port));
      const siblingEnv = path.join(stateDir, "gateways", "9124");
      fs.mkdirSync(selectedEnv, { recursive: true });
      fs.mkdirSync(siblingEnv, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "managed_swap"), "/swapfile");
      const runCalls: string[][] = [];

      const result = runPortUninstall(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: (command) => command !== "docker" && command !== "pgrep",
          env: {
            HOME: tmpHome,
            NEMOCLAW_GATEWAY_PORT: String(port),
            NEMOCLAW_NON_INTERACTIVE: "",
          } as NodeJS.ProcessEnv,
          existsSync: (target) =>
            target === "/swapfile" || (target.startsWith(tmpHome) && fs.existsSync(target)),
          isTty: true,
          log: vi.fn(),
          rmSync: fs.rmSync,
          run: (_command, args) => {
            runCalls.push(args);
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runCalls.some((args) => args[0] === "swapoff")).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "managed_swap"))).toBe(true);
      expect(fs.existsSync(selectedEnv)).toBe(false);
      expect(fs.existsSync(siblingEnv)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
