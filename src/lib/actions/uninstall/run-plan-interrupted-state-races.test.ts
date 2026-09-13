// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bindGatewayAuthorityToCheckpoint } from "../../onboard/gateway-authority-checkpoint";
import { createSession } from "../../state/onboard-session";
import type { RunResult } from "./run-plan";

const ADMISSION_MESSAGE =
  "No sandbox or gateway process was created; continuing cleanup of the interrupted onboarding state.";

function ok(stdout = ""): RunResult {
  return { status: 0, stderr: "", stdout };
}

function writeInterruptedSession(stateRoot: string, checkpointPort: number): void {
  const now = new Date().toISOString();
  const session = createSession({ agent: "openclaw", mode: "non-interactive" });
  session.status = "failed";
  session.lastStepStarted = "preflight";
  session.failure = {
    interrupted: true,
    message: "Onboarding was interrupted during preflight.",
    recordedAt: now,
    step: "preflight",
  };
  session.steps.preflight = {
    completedAt: null,
    error: session.failure.message,
    startedAt: now,
    status: "failed",
  };
  session.machine = { revision: 1, state: "failed", stateEnteredAt: now, version: 1 };
  bindGatewayAuthorityToCheckpoint(session, {
    endpoint: null,
    gatewayName: `nemoclaw-${String(checkpointPort)}`,
    gatewayPort: checkpointPort,
    mode: "nemoclaw-managed",
    requiredCapabilities: [],
    source: "standalone",
    stateDir: null,
    supervisor: null,
  });
  fs.writeFileSync(path.join(stateRoot, "onboard-session.json"), `${JSON.stringify(session)}\n`, {
    mode: 0o600,
  });
}

function writeLiveReplacementState(stateRoot: string): void {
  fs.mkdirSync(stateRoot, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(stateRoot, "new-onboarding-state"), "new\n");
  fs.writeFileSync(
    path.join(stateRoot, "onboard.lock"),
    `${JSON.stringify({
      command: "nemoclaw onboard",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
}

interface RunInterruptedUninstallOptions {
  checkpointPort?: number;
  gatewayNames?: string[];
  onLog?: (message: string) => void;
}

async function runInterruptedUninstall(
  tmpHome: string,
  port: number,
  options: RunInterruptedUninstallOptions = {},
) {
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
  vi.resetModules();
  const { runUninstallPlan } = await import("./run-plan");
  const stateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
  fs.mkdirSync(stateRoot, { mode: 0o700, recursive: true });
  writeInterruptedSession(stateRoot, options.checkpointPort ?? port);
  const errors: string[] = [];
  const calls: string[][] = [];
  const gatewayNames = options.gatewayNames ?? [];
  const onLog = options.onLog ?? (() => undefined);
  const outcome = await runUninstallPlan(
    {
      assumeYes: true,
      deleteModels: false,
      destroyUserData: false,
      gatewayName: `nemoclaw-${String(port)}`,
      keepOpenShell: false,
    },
    {
      commandExists: (command) => command === "openshell" || command === "pgrep",
      env: { HOME: tmpHome, NEMOCLAW_GATEWAY_PORT: String(port) },
      error: (message) => errors.push(message),
      existsSync: (target) => target.startsWith(tmpHome) && fs.existsSync(target),
      hasPortableRuntimeCleanup: () => false,
      isPortFree: () => true,
      isTty: false,
      log: onLog,
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        endpoint: null,
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        requiredCapabilities: [],
        source: "standalone",
        stateDir: null,
        supervisor: null,
      }),
      rmSync: fs.rmSync,
      run: (command, args) => {
        calls.push([command, ...args]);
        return command === "pgrep" || command === "ps"
          ? { ...ok(), status: 1 }
          : command === "openshell" && args[0] === "gateway" && args[1] === "list"
            ? ok(JSON.stringify(gatewayNames.map((name) => ({ name }))))
            : ok();
      },
      runDocker: () => ok(),
    },
  );
  return { calls, errors, outcome, stateRoot };
}

function nonListOpenShellCalls(calls: readonly string[][]): string[][] {
  return calls.filter(
    ([command, resource, action]) =>
      command === "openshell" && !(resource === "gateway" && action === "list"),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("interrupted pre-gateway uninstall races (#11395)", () => {
  it("switches to scoped cleanup when a sibling appears after admission", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-late-sibling-"));
    const port = 9123;
    const gatewayNames: string[] = [];
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        gatewayNames,
        onLog: (message) =>
          message === ADMISSION_MESSAGE ? gatewayNames.push("nemoclaw") : undefined,
      });

      expect(result.outcome.exitCode, result.errors.join("\n")).toBe(0);
      expect(result.outcome.otherGatewayEnvironmentsRemain).toBe(true);
      expect(fs.existsSync(result.stateRoot)).toBe(false);
      expect(result.errors.join("\n")).toContain(
        "A sibling gateway appeared during interrupted-state cleanup; switching to gateway-scoped cleanup.",
      );
      expect(nonListOpenShellCalls(result.calls)).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("reclaims a stale onboarding lock", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-stale-lock-"));
    const port = 9123;
    try {
      const stateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
      fs.mkdirSync(stateRoot, { mode: 0o700, recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "onboard.lock"),
        `${JSON.stringify({
          command: "nemoclaw onboard",
          pid: 2_147_483_647,
          startedAt: "2000-01-01T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      const result = await runInterruptedUninstall(tmpHome, port);

      expect(result.outcome.exitCode, result.errors.join("\n")).toBe(0);
      expect(fs.existsSync(result.stateRoot)).toBe(false);
      expect(nonListOpenShellCalls(result.calls)).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("preserves a failed checkpoint bound to another gateway", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(process.cwd(), "nemoclaw-uninstall-other-checkpoint-"),
    );
    const port = 9123;
    try {
      const result = await runInterruptedUninstall(tmpHome, port, { checkpointPort: port + 1 });

      expect(
        result.outcome.exitCode,
        `${result.errors.join("\n")}\nstate exists: ${String(fs.existsSync(result.stateRoot))}`,
      ).toBe(1);
      expect(fs.existsSync(result.stateRoot)).toBe(true);
      expect(result.errors.join("\n")).toContain(
        "The interrupted onboarding checkpoint does not authorize this gateway; preserving it for retry.",
      );
      expect(nonListOpenShellCalls(result.calls)).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("preserves onboarding state recreated after atomic detachment", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-recreated-state-"));
    const port = 9123;
    const stateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      return path.resolve(String(source)) === path.resolve(stateRoot) &&
        String(destination).includes(".uninstall-")
        ? writeLiveReplacementState(stateRoot)
        : undefined;
    });
    try {
      const result = await runInterruptedUninstall(tmpHome, port);

      expect(result.outcome.exitCode, result.errors.join("\n")).toBe(0);
      expect(fs.readFileSync(path.join(stateRoot, "new-onboarding-state"), "utf8")).toBe("new\n");
      expect(fs.existsSync(path.join(stateRoot, "onboard.lock"))).toBe(true);
      expect(nonListOpenShellCalls(result.calls)).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });
});
