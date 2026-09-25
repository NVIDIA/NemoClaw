// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writePreGatewaySession } from "../../../../test/support/uninstall-pre-gateway-session";
import {
  acquireOnboardStateLock,
  releaseOnboardStateLock,
  type OnboardStateLockHandle,
} from "../../state/onboard-session/lock";
import type { RunResult } from "./run-plan";

const ADMISSION_MESSAGE =
  "No sandbox or gateway process was created; continuing cleanup of the interrupted onboarding state.";

function ok(stdout = ""): RunResult {
  return { status: 0, stderr: "", stdout };
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
  initialStateRoot?: (stateRoot: string) => string;
  onLog?: (message: string) => void;
  prepareState?: (stateRoot: string) => void;
  realpathSync?: (target: string) => string;
  rmSync?: typeof fs.rmSync;
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
  const initialStateRoot = options.initialStateRoot?.(stateRoot) ?? stateRoot;
  fs.mkdirSync(initialStateRoot, { mode: 0o700, recursive: true });
  writePreGatewaySession(initialStateRoot, options.checkpointPort ?? port, "interrupted");
  const errors: string[] = [];
  const logs: string[] = [];
  const calls: string[][] = [];
  const gatewayNames = options.gatewayNames ?? [];
  const onLog = options.onLog ?? (() => undefined);
  options.prepareState?.(initialStateRoot);
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
      log: (message) => {
        logs.push(message);
        onLog(message);
      },
      realpathSync: options.realpathSync,
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
      rmSync: options.rmSync ?? fs.rmSync,
      run: (command, args) => {
        calls.push([command, ...args]);
        return command === "pgrep" || command === "ps"
          ? { ...ok(), status: 1 }
          : command === "openshell" && args[0] === "gateway" && args[1] === "list"
            ? ok(JSON.stringify(gatewayNames.map((name) => ({ name }))))
            : ok();
      },
      runDocker: () => ok(),
      sleep: () => undefined,
    },
  );
  return { calls, errors, logs, outcome, stateRoot };
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
  it("preserves selected state when its home cannot be resolved", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-home-resolution-"));
    const port = 9123;
    const resolutionFailure = Object.assign(new Error("injected home resolution failure"), {
      code: "ENOENT",
    });
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        prepareState: () =>
          fs.mkdirSync(path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`), {
            mode: 0o700,
          }),
        realpathSync: () => {
          throw resolutionFailure;
        },
      });

      expect(result.outcome.exitCode).toBe(1);
      expect(fs.existsSync(result.stateRoot)).toBe(true);
      expect(result.errors.join("\n")).toContain(
        "Unable to resolve interrupted-uninstall recovery state before cleanup",
      );
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("uses scoped cleanup when a sibling already owns its onboarding lock", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-active-sibling-"));
    const port = 9123;
    const siblingRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port + 1));
    const siblingLock = acquireOnboardStateLock(siblingRoot, tmpHome, "nemoclaw onboard");
    const siblingLockHandle = siblingLock.handle as OnboardStateLockHandle;
    expect(siblingLock.acquired).toBe(true);
    try {
      const result = await runInterruptedUninstall(tmpHome, port);

      expect(result.outcome.exitCode, result.errors.join("\n")).toBe(0);
      expect(result.outcome.otherGatewayEnvironmentsRemain).toBe(true);
      expect(fs.existsSync(result.stateRoot)).toBe(false);
      expect(result.errors.join("\n")).toContain(
        "A sibling gateway appeared during interrupted-state cleanup; switching to gateway-scoped cleanup.",
      );
      expect(nonListOpenShellCalls(result.calls)).toEqual([]);
    } finally {
      releaseOnboardStateLock(siblingLockHandle);
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("fences a sibling onboarding attempt before shared cleanup begins", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-sibling-fence-"));
    const port = 9123;
    const siblingRoot = path.join(tmpHome, ".nemoclaw");
    const migrationLock = path.join(tmpHome, ".nemoclaw", ".gateway-state-migration.lock");
    let siblingAttempts = 0;
    const attemptSiblingOnboarding = () => {
      siblingAttempts += 1;
      expect(fs.existsSync(migrationLock)).toBe(true);
      const acquisition = acquireOnboardStateLock(
        siblingRoot,
        tmpHome,
        "nemoclaw onboard",
        migrationLock,
      );
      expect(acquisition.acquired).toBe(false);
      expect(acquisition.handle).toBeUndefined();
    };
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        onLog: (message) =>
          message.includes("] Stopping services") ? attemptSiblingOnboarding() : undefined,
      });

      expect(result.outcome.exitCode, result.errors.join("\n")).toBe(0);
      expect(result.outcome.otherGatewayEnvironmentsRemain).toBe(false);
      expect(siblingAttempts).toBe(1);
      expect(fs.existsSync(migrationLock)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

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

  it("reports the lock path when a recent malformed onboarding lock blocks cleanup", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-malformed-lock-"));
    const port = 9123;
    const lockFile = path.join(tmpHome, ".nemoclaw", "gateways", String(port), "onboard.lock");
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        prepareState: () => fs.writeFileSync(lockFile, "{\n", { mode: 0o600 }),
      });

      expect(result.outcome.exitCode).toBe(1);
      expect(fs.existsSync(result.stateRoot)).toBe(true);
      expect(result.errors.join("\n")).toContain(`The onboarding lock at ${lockFile}`);
      expect(result.errors.join("\n")).toContain("has not changed for at least 30 seconds");
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
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameSync(source, destination);
      return path.resolve(String(source)) === path.resolve(stateRoot) &&
        path.resolve(String(destination)) === path.resolve(detachedRoot)
        ? writeLiveReplacementState(stateRoot)
        : undefined;
    });
    try {
      const result = await runInterruptedUninstall(tmpHome, port);

      expect(result.outcome.exitCode, result.errors.join("\n")).toBe(0);
      expect(fs.readFileSync(path.join(stateRoot, "new-onboarding-state"), "utf8")).toBe("new\n");
      expect(fs.existsSync(path.join(stateRoot, "onboard.lock"))).toBe(true);
      expect(fs.existsSync(detachedRoot)).toBe(false);
      expect(nonListOpenShellCalls(result.calls)).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("recovers preserved data from abandoned staging before cleanup", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(process.cwd(), "nemoclaw-uninstall-staging-recovery-"),
    );
    const port = 9123;
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        initialStateRoot: () => detachedRoot,
        prepareState: (initialStateRoot) => {
          const backupFile = path.join(initialStateRoot, "backups", "workspace.tar");
          fs.mkdirSync(path.dirname(backupFile), { mode: 0o700, recursive: true });
          fs.writeFileSync(backupFile, "preserved\n");
        },
      });

      expect(result.outcome.exitCode, result.errors.join("\n")).toBe(0);
      expect(fs.readFileSync(path.join(result.stateRoot, "backups", "workspace.tar"), "utf8")).toBe(
        "preserved\n",
      );
      expect(result.logs.join("\n")).toContain(
        "Recovered preserved state from an interrupted uninstall: backups",
      );
      expect(fs.existsSync(detachedRoot)).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("does not inspect a replacement through the abandoned staging pathname", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-recovery-swap-"));
    const port = 9123;
    const stateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    const originalRoot = `${detachedRoot}.original`;
    let quarantineRoot: string | null = null;
    const lstatSync = fs.lstatSync.bind(fs);
    const renameSync = fs.renameSync.bind(fs);
    const swaps = new Map<string, () => void>([
      [
        path.resolve(detachedRoot),
        () => {
          renameSync(detachedRoot, originalRoot);
          fs.mkdirSync(path.join(detachedRoot, "backups"), { mode: 0o700, recursive: true });
          fs.writeFileSync(path.join(detachedRoot, "backups", "replacement.tar"), "replacement\n");
        },
      ],
    ]);
    vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      const stat = lstatSync(target, options as never);
      const resolved = path.resolve(String(target));
      const swap = swaps.get(resolved);
      swaps.delete(resolved);
      swap?.();
      return stat;
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      const destinationPath = String(destination);
      quarantineRoot =
        path.resolve(String(source)) === path.resolve(detachedRoot) &&
        destinationPath.startsWith(`${detachedRoot}.cleanup-`)
          ? destinationPath
          : quarantineRoot;
      return renameSync(source, destination);
    });
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        initialStateRoot: () => detachedRoot,
        prepareState: (initialStateRoot) => {
          const backupFile = path.join(initialStateRoot, "backups", "original.tar");
          fs.mkdirSync(path.dirname(backupFile), { mode: 0o700, recursive: true });
          fs.writeFileSync(backupFile, "original\n");
        },
      });

      expect(result.outcome.exitCode).toBe(1);
      expect(quarantineRoot).not.toBeNull();
      expect(fs.readFileSync(path.join(originalRoot, "backups", "original.tar"), "utf8")).toBe(
        "original\n",
      );
      expect(
        fs.readFileSync(path.join(quarantineRoot!, "backups", "replacement.tar"), "utf8"),
      ).toBe("replacement\n");
      expect(fs.existsSync(path.join(stateRoot, "backups"))).toBe(false);
      expect(result.errors.join("\n")).toContain("changed identity");
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("retries cleanup from a UUID quarantine after recursive removal fails", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(process.cwd(), "nemoclaw-uninstall-quarantine-retry-"),
    );
    const port = 9123;
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    let failedQuarantineRoot: string | null = null;
    const failQuarantineRemoval: typeof fs.rmSync = (target) => {
      failedQuarantineRoot = String(target);
      throw new Error("injected quarantine removal failure");
    };
    const rmSync: typeof fs.rmSync = (target, options) =>
      failedQuarantineRoot === null && String(target).startsWith(`${detachedRoot}.cleanup-`)
        ? failQuarantineRemoval(target)
        : fs.rmSync(target, options);
    try {
      const first = await runInterruptedUninstall(tmpHome, port, {
        initialStateRoot: () => detachedRoot,
        rmSync,
      });

      expect(first.outcome.exitCode).toBe(1);
      expect(failedQuarantineRoot).not.toBeNull();
      expect(fs.existsSync(detachedRoot)).toBe(false);
      expect(fs.existsSync(failedQuarantineRoot!)).toBe(true);
      expect(first.errors.join("\n")).toContain(
        `Unable to remove abandoned interrupted-uninstall state at ${failedQuarantineRoot!}`,
      );

      const second = await runInterruptedUninstall(tmpHome, port);

      expect(second.outcome.exitCode, second.errors.join("\n")).toBe(0);
      expect(fs.existsSync(failedQuarantineRoot!)).toBe(false);
      expect(
        fs
          .readdirSync(tmpHome)
          .some((entry) => entry.startsWith(`${path.basename(detachedRoot)}.cleanup-`)),
      ).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("does not merge abandoned staging into newer selected state", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-newer-state-"));
    const port = 9123;
    const stateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        initialStateRoot: () => detachedRoot,
        prepareState: (initialStateRoot) => {
          const backupFile = path.join(initialStateRoot, "backups", "workspace.tar");
          fs.mkdirSync(path.dirname(backupFile), { mode: 0o700, recursive: true });
          fs.writeFileSync(backupFile, "preserved\n");
          writeLiveReplacementState(stateRoot);
        },
      });

      expect(result.outcome.exitCode).toBe(1);
      expect(fs.readFileSync(path.join(stateRoot, "new-onboarding-state"), "utf8")).toBe("new\n");
      expect(fs.existsSync(path.join(stateRoot, "backups"))).toBe(false);
      const quarantineName = fs
        .readdirSync(tmpHome)
        .find((entry) => entry.startsWith(`${path.basename(detachedRoot)}.cleanup-`));
      expect(quarantineName).toBeDefined();
      expect(
        fs.readFileSync(path.join(tmpHome, quarantineName!, "backups", "workspace.tar"), "utf8"),
      ).toBe("preserved\n");
      expect(result.errors.join("\n")).toContain(
        "Unable to recover preserved state because newer selected state exists",
      );
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("preserves selected state when abandoned staging is broadly accessible", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-unsafe-staging-"));
    const port = 9123;
    const stagingPath = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    fs.mkdirSync(stagingPath, { mode: 0o700, recursive: true });
    fs.chmodSync(stagingPath, 0o777);
    try {
      const result = await runInterruptedUninstall(tmpHome, port);

      expect(result.outcome.exitCode).toBe(1);
      expect(fs.existsSync(result.stateRoot)).toBe(true);
      expect(result.errors.join("\n")).toContain("grants access to group or other users");
      expect(fs.statSync(stagingPath).mode & 0o777).toBe(0o777);
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("preserves a replacement when quarantined staging changes identity", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-stage-identity-"));
    const port = 9123;
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    let quarantineRoot: string | null = null;
    let preservedRoot: string | null = null;
    const renameSync = fs.renameSync.bind(fs);
    const replaceQuarantine = (source: fs.PathLike, destination: fs.PathLike) => {
      const destinationPath = String(destination);
      renameSync(source, destination);
      quarantineRoot = destinationPath;
      preservedRoot = `${destinationPath}.original`;
      renameSync(destination, preservedRoot);
      fs.mkdirSync(destinationPath, { mode: 0o700 });
      fs.writeFileSync(path.join(destinationPath, "replacement"), "new\n");
    };
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      path.resolve(String(source)) === path.resolve(detachedRoot) &&
      String(destination).startsWith(`${detachedRoot}.cleanup-`)
        ? replaceQuarantine(source, destination)
        : renameSync(source, destination),
    );
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        initialStateRoot: () => detachedRoot,
      });

      expect(result.outcome.exitCode).toBe(1);
      expect(quarantineRoot).not.toBeNull();
      expect(preservedRoot).not.toBeNull();
      expect(fs.readFileSync(path.join(quarantineRoot!, "replacement"), "utf8")).toBe("new\n");
      expect(fs.existsSync(path.join(preservedRoot!, "onboard-session.json"))).toBe(true);
      expect(result.errors.join("\n")).toContain("changed identity");
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("does not follow a staging-path replacement during detachment", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-stage-swap-"));
    const port = 9123;
    const stateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    const replacementTarget = path.join(tmpHome, "replacement-target");
    fs.mkdirSync(replacementTarget, { mode: 0o700 });
    const renameSync = fs.renameSync.bind(fs);
    const replaceThenRename = (source: fs.PathLike, destination: fs.PathLike) => {
      fs.symlinkSync(replacementTarget, detachedRoot, "dir");
      return renameSync(source, destination);
    };
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      path.resolve(String(source)) === path.resolve(stateRoot) &&
      path.resolve(String(destination)) === path.resolve(detachedRoot)
        ? replaceThenRename(source, destination)
        : renameSync(source, destination),
    );
    try {
      const result = await runInterruptedUninstall(tmpHome, port);

      expect(result.outcome.exitCode).toBe(1);
      expect(fs.existsSync(stateRoot)).toBe(true);
      expect(fs.lstatSync(detachedRoot).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(replacementTarget)).toEqual([]);
      expect(result.errors.join("\n")).toContain(
        "Unable to detach interrupted onboarding state for cleanup; it was preserved",
      );
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("reports and preserves detached state when recursive removal fails", async () => {
    const tmpHome = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-uninstall-detached-rm-"));
    const port = 9123;
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    const failRemoval: typeof fs.rmSync = () => {
      throw new Error("injected detached-state removal failure");
    };
    const rmSync: typeof fs.rmSync = (target, options) =>
      (path.resolve(String(target)) === path.resolve(detachedRoot) ? failRemoval : fs.rmSync)(
        target,
        options,
      );
    try {
      const result = await runInterruptedUninstall(tmpHome, port, { rmSync });

      expect(result.outcome.exitCode).toBe(1);
      expect(fs.existsSync(result.stateRoot)).toBe(false);
      expect(fs.existsSync(detachedRoot)).toBe(true);
      expect(result.errors.join("\n")).toContain(
        `Unable to remove detached interrupted-onboarding state at ${detachedRoot}`,
      );
      expect(result.errors.join("\n")).toContain(
        "Cleanup stopped with recovery state at that path",
      );
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });

  it("reports a preserved-data restore collision without rejecting", async () => {
    const tmpHome = fs.mkdtempSync(
      path.join(process.cwd(), "nemoclaw-uninstall-restore-collision-"),
    );
    const port = 9123;
    const stateRoot = path.join(tmpHome, ".nemoclaw", "gateways", String(port));
    const detachedRoot = path.join(tmpHome, `.nemoclaw-uninstall-staging-${String(port)}`);
    const restoreSource = path.join(detachedRoot, "backups");
    const restoreDestination = path.join(stateRoot, "backups");
    const renameSync = fs.renameSync.bind(fs);
    const collideWithRestore = (source: fs.PathLike, destination: fs.PathLike) => {
      fs.mkdirSync(String(destination), { mode: 0o700, recursive: true });
      fs.writeFileSync(path.join(String(destination), "new-backup"), "new\n");
      return renameSync(source, destination);
    };
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      path.resolve(String(source)) === path.resolve(restoreSource)
        ? collideWithRestore(source, destination)
        : renameSync(source, destination),
    );
    try {
      const result = await runInterruptedUninstall(tmpHome, port, {
        prepareState: (root) => {
          fs.mkdirSync(path.join(root, "backups"));
          fs.writeFileSync(path.join(root, "backups", "original-backup"), "original\n");
        },
      });

      expect(result.outcome.exitCode).toBe(1);
      expect(result.errors.join("\n")).toContain("Unable to restore preserved backups:");
      expect(fs.readFileSync(path.join(restoreDestination, "new-backup"), "utf8")).toBe("new\n");
      expect(fs.readFileSync(path.join(restoreSource, "original-backup"), "utf8")).toBe(
        "original\n",
      );
    } finally {
      fs.rmSync(tmpHome, { force: true, recursive: true });
    }
  });
});
