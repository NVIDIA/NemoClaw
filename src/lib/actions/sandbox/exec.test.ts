// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { execTimeout, testTimeoutOptions } from "../../../../test/helpers/timeouts";

import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
  isMcpLifecycleLockHeld,
} from "../../state/mcp-lifecycle-lock-acquisition";
import {
  withPortableHostFence,
  portableHostFencePath,
} from "../../state/portable-uninstall-retirement";
import {
  execSandbox,
  startSandboxExec,
  type SandboxExecCleanupDeps,
  workdirMissingMessage,
} from "./exec";

describe("workdirMissingMessage", () => {
  it("renders a user-facing CLI error with the offending path", () => {
    expect(workdirMissingMessage("/sandbox/workspace")).toBe(
      "error: --workdir: /sandbox/workspace does not exist inside the sandbox",
    );
  });
});

// End-to-end wiring of the post-exec policy-denial hint through execSandbox
// (#5978): proves the breadcrumb fires for a denied failure while the command's
// exit code is preserved, and stays silent on success and unrelated failures.
// All host seams are injected so the test never spawns openshell or touches the
// registry (getSandbox returns null, so cleanup is a no-op).
describe("execSandbox policy-denial hint wiring (#5978)", () => {
  const START_MS = 1_000_000;
  // Epoch [1000.500] parses to 1000500ms, at/after START so it is "fresh".
  const DENIAL_LINE =
    "[1000.500] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]";

  const cleanupSkipped: SandboxExecCleanupDeps = {
    getSandbox: () => null,
    inspectMutableConfigPerms: vi.fn(() => {
      throw new Error("cleanup should be skipped for an unregistered sandbox");
    }) as unknown as SandboxExecCleanupDeps["inspectMutableConfigPerms"],
    repairMutableConfigPerms: vi.fn(() => {
      throw new Error("cleanup should be skipped for an unregistered sandbox");
    }) as unknown as SandboxExecCleanupDeps["repairMutableConfigPerms"],
  };

  const runExec = async (
    status: number | null,
    probeOutput: string,
    options: {
      error?: Error;
      now?: () => number;
      onRun?: () => void;
      probeError?: Error;
      cleanupDeps?: SandboxExecCleanupDeps;
      writeStderr?: (line: string) => void;
    } = {},
  ) => {
    const stderr: string[] = [];
    const probeError = options.probeError;
    const probeLogs = vi.fn(
      probeError
        ? () => {
            throw probeError;
          }
        : () => probeOutput,
    );
    const enableAudit = vi.fn(() => {});
    let exitCode = Number.NaN;
    const exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__exec_exit__");
    }) as (code: number) => never;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await execSandbox(
      "wire-sbx",
      ["curl", "-sS", "https://example.com/"],
      {},
      {
        selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
        commandExecutor: {
          probeDirectory: async () => ({ state: "present" }),
          runStreaming: async () => {
            options.onRun?.();
            return {
              outcome: options.error
                ? {
                    kind: "failed" as const,
                    error: { kind: "invocation" as const, message: options.error.message },
                  }
                : { kind: "completed" as const, exitCode: status ?? 1 },
              release: () => {},
            };
          },
        },
        cleanupDeps: options.cleanupDeps ?? cleanupSkipped,
        exit,
        policyHint: {
          now: options.now ?? (() => START_MS),
          env: {},
          probeLogs,
          enableAudit,
          sleep: async () => {},
          attempts: 1,
          writeStderr: options.writeStderr ?? ((line) => stderr.push(line)),
        },
      },
    ).catch(() => {});
    errSpy.mockRestore();
    return { enableAudit, exitCode, probeLogs, stderr };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends the breadcrumb and preserves the command exit code on a denied failure", async () => {
    const { exitCode, stderr } = await runExec(56, DENIAL_LINE);
    expect(exitCode).toBe(56);
    expect(stderr.join("\n")).toContain(
      "recent network policy denial detected for example.com:443",
    );
    expect(stderr.join("\n")).toContain("nemoclaw wire-sbx logs --tail 50");
  });

  it("stays silent and exits 0 on success", async () => {
    const { exitCode, stderr } = await runExec(0, DENIAL_LINE);
    expect(exitCode).toBe(0);
    expect(stderr).toHaveLength(0);
  });

  it("stays silent and preserves the exit code on an unrelated failure", async () => {
    // A present-but-non-denial log line exercises the filter, not just "no logs".
    const { exitCode, stderr } = await runExec(
      2,
      "[1000.500] [sandbox] [INFO ] some unrelated runtime error: connection reset",
    );
    expect(exitCode).toBe(2);
    expect(stderr).toHaveLength(0);
  });

  it("does not probe policy logs when OpenShell invocation fails", async () => {
    const { enableAudit, exitCode, probeLogs, stderr } = await runExec(null, DENIAL_LINE, {
      error: new Error("openshell: command not found"),
    });
    expect(exitCode).toBe(1);
    expect(enableAudit).not.toHaveBeenCalled();
    expect(probeLogs).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(0);
  });

  it("preserves the command exit code when policy-hint stderr writing throws", async () => {
    const { exitCode } = await runExec(56, DENIAL_LINE, {
      writeStderr: () => {
        throw new Error("stderr unavailable");
      },
    });
    expect(exitCode).toBe(56);
  });

  it("preserves the command exit code when the policy log probe fails", async () => {
    const { exitCode, probeLogs, stderr } = await runExec(56, "", {
      probeError: Object.assign(new Error("OpenShell log read timed out"), {
        code: "ETIMEDOUT",
      }),
    });
    expect(exitCode).toBe(56);
    expect(probeLogs).toHaveBeenCalledOnce();
    expect(stderr).toHaveLength(0);
  });

  it("emits after active OpenClaw cleanup and preserves the command exit code", async () => {
    const inspectMutableConfigPerms = vi
      .fn<SandboxExecCleanupDeps["inspectMutableConfigPerms"]>()
      .mockReturnValueOnce({
        applies: true,
        ok: false,
        issues: ["config mode differs from runtime contract"],
      });
    const repairMutableConfigPerms = vi.fn(() => ({
      applied: true as const,
      verified: true as const,
      errors: [],
    }));
    const { exitCode, stderr } = await runExec(56, DENIAL_LINE, {
      cleanupDeps: {
        getSandbox: () => ({ agent: "openclaw" }),
        inspectMutableConfigPerms,
        repairMutableConfigPerms,
      },
    });
    expect(inspectMutableConfigPerms).toHaveBeenCalledOnce();
    expect(repairMutableConfigPerms).toHaveBeenCalledOnce();
    expect(exitCode).toBe(56);
    expect(stderr.join("\n")).toContain("recent network policy denial detected");
  });

  it("captures the denial cutoff before dispatch and rejects an older denial", async () => {
    let dispatched = false;
    const now = vi.fn(() => {
      expect(dispatched).toBe(false);
      return START_MS;
    });
    const staleDenial =
      "[999.999] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]";
    const { exitCode, stderr } = await runExec(56, staleDenial, {
      now,
      onRun: () => {
        dispatched = true;
      },
    });
    expect(now).toHaveBeenCalledOnce();
    expect(dispatched).toBe(true);
    expect(exitCode).toBe(56);
    expect(stderr).toHaveLength(0);
  });
});

describe("execSandbox scope-upgrade hint wiring (#9744)", () => {
  const cleanupSkipped: SandboxExecCleanupDeps = {
    getSandbox: () => null,
    inspectMutableConfigPerms: vi.fn(() => {
      throw new Error("cleanup should be skipped for an unregistered sandbox");
    }) as unknown as SandboxExecCleanupDeps["inspectMutableConfigPerms"],
    repairMutableConfigPerms: vi.fn(() => {
      throw new Error("cleanup should be skipped for an unregistered sandbox");
    }) as unknown as SandboxExecCleanupDeps["repairMutableConfigPerms"],
  };

  const UNRELATED_ADMIN_PENDING = JSON.stringify({
    pending: [
      {
        requestId: "c0ffee00-dead-4beef-b0bb-000000000001",
        device: "unrelated-device-fingerprint",
        scopes: ["operator.admin"],
      },
    ],
  });

  const runOpenClawExec = async (status: number, devicesJson: string) => {
    const stderr: string[] = [];
    const probePendingDevices = vi.fn(() => devicesJson);
    let exitCode = Number.NaN;
    const exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__exec_exit__");
    }) as (code: number) => never;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await execSandbox(
      "wire-sbx",
      ["openclaw", "cron", "add"],
      {},
      {
        selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
        commandExecutor: {
          probeDirectory: async () => ({ state: "present" }),
          runStreaming: async () => ({
            outcome: { kind: "completed", exitCode: status },
            release: () => {},
          }),
        },
        cleanupDeps: cleanupSkipped,
        exit,
        policyHint: {
          now: () => 0,
          env: {},
          probeLogs: () => "",
          enableAudit: () => {},
          sleep: async () => {},
          attempts: 1,
          probePendingDevices,
          writeStderr: (line) => stderr.push(line),
        },
      },
    ).catch(() => {});
    errSpy.mockRestore();
    return { exitCode, probePendingDevices, stderr: stderr.join("\n") };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the prepared review shell and preserves the exit code when a request is pending", async () => {
    const { exitCode, stderr } = await runOpenClawExec(1, UNRELATED_ADMIN_PENDING);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("nemoclaw wire-sbx connect");
    expect(stderr).toContain("openclaw devices list --json");
  });

  it.each([
    ["the uncorrelated request id", "c0ffee00-dead-4beef-b0bb-000000000001"],
    ["the requested scopes", "operator.admin"],
    ["the requesting device", "unrelated-device-fingerprint"],
  ])("never presents %s as this command's remedy", async (_label, leaked) => {
    const { stderr } = await runOpenClawExec(1, UNRELATED_ADMIN_PENDING);
    expect(stderr).toContain("openclaw devices approve <requestId>");
    expect(stderr).not.toContain("exec -- openclaw devices approve");
    expect(stderr).not.toContain(leaked);
  });

  it("skips the probe entirely when the openclaw command succeeds", async () => {
    const { exitCode, probePendingDevices, stderr } = await runOpenClawExec(
      0,
      UNRELATED_ADMIN_PENDING,
    );
    expect(exitCode).toBe(0);
    expect(probePendingDevices).not.toHaveBeenCalled();
    expect(stderr).toBe("");
  });

  it("stays silent when the failure leaves no pending request", async () => {
    const { exitCode, stderr } = await runOpenClawExec(1, JSON.stringify({ pending: [] }));
    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
  });
});

it.each([
  { mode: "sync", error: new Error("lock timed out"), commandCode: 0, invocationFailed: false },
  {
    mode: "async",
    error: new Error("migration blocked"),
    commandCode: 23,
    invocationFailed: false,
  },
  { mode: "async", error: "registry unavailable", commandCode: 1, invocationFailed: true },
])(
  "reports $mode cleanup authority failure after command status $commandCode (#11647)",
  async ({ mode, error, commandCode, invocationFailed }) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const release = vi.fn();
    const inspect = vi.fn(() => ({ applies: true as const, ok: true, issues: [] }));
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });
    try {
      const finish = await startSandboxExec(
        "alpha",
        ["true"],
        {},
        {
          selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
          commandExecutor: {
            probeDirectory: async () => ({ state: "present" }),
            runStreaming: async () => ({
              outcome: invocationFailed
                ? { kind: "failed", error: { kind: "invocation", message: "transport failed" } }
                : { kind: "completed", exitCode: commandCode },
              release,
            }),
          },
          withCleanupAuthority:
            mode === "sync"
              ? () => {
                  throw error;
                }
              : () => Promise.reject(error),
          cleanupDeps: {
            getSandbox: () => ({ agent: "openclaw" }),
            inspectMutableConfigPerms: inspect,
            repairMutableConfigPerms: () => ({ applied: true, verified: true, errors: [] }),
          },
          policyHint: {
            env: {},
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
          },
          exit,
        },
      );
      await expect(finish()).rejects.toThrow("exit:1");
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(stderr).toHaveBeenCalledWith(
        `  OpenClaw permission cleanup failed (command exit ${commandCode}; cleanup exit 1): cleanup authority unavailable: ${error instanceof Error ? error.message : error}`,
      );
      expect(
        stderr.mock.calls.filter(([line]) => String(line).includes("Failed to invoke openshell")),
      ).toHaveLength(invocationFailed ? 1 : 0);
      expect(inspect).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  },
);

it(
  "releases authority to another process before interactive completion (#11647)",
  testTimeoutOptions(15_000),
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launch-exec-"));
    const stateDir = path.join(home, "state");
    const lockOptions = { stateDir };
    const sandboxName = "launch-exec";
    let endSession: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      endSession = resolve;
    });
    const release = vi.fn();
    const cleanup = vi.fn(() =>
      withMcpLifecycleLockSync(
        sandboxName,
        () => {
          expect(isMcpLifecycleLockHeld(sandboxName, stateDir)).toBe(true);
          return { applies: true as const, ok: true, issues: [] };
        },
        lockOptions,
      ),
    );
    let dispatched = false;
    let lockHeldDuringCleanup: boolean | null = null;
    let fenceHeldDuringCleanup: boolean | null = null;
    try {
      const finish = await withPortableHostFence(home, () =>
        withMcpLifecycleLock(
          sandboxName,
          () =>
            startSandboxExec(
              sandboxName,
              ["bash", "-lc", "openclaw tui"],
              { tty: true, stdin: true, timeoutSeconds: 0 },
              {
                selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
                commandExecutor: {
                  probeDirectory: async () => ({ state: "present" }),
                  runStreaming: async () => {
                    expect(isMcpLifecycleLockHeld(sandboxName, stateDir)).toBe(true);
                    expect(fs.existsSync(portableHostFencePath(home))).toBe(true);
                    dispatched = true;
                    await ended;
                    return { outcome: { kind: "completed", exitCode: 0 }, release };
                  },
                },
                cleanupDeps: {
                  getSandbox: () => {
                    lockHeldDuringCleanup = isMcpLifecycleLockHeld(sandboxName, stateDir);
                    fenceHeldDuringCleanup = fs.existsSync(portableHostFencePath(home));
                    return { agent: "openclaw" };
                  },
                  inspectMutableConfigPerms: cleanup,
                  repairMutableConfigPerms: () => {
                    throw new Error("healthy config needs no repair");
                  },
                },
                exit: (code) => {
                  throw new Error(`exit:${code}`);
                },
              },
            ),
          lockOptions,
        ),
      );
      expect(dispatched).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      const contender = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        const retirement = (await import(process.argv[1])).default;
        const lifecycle = (await import(process.argv[2])).default;
        await retirement.withPortableHostFence(process.argv[3], () =>
          lifecycle.withMcpLifecycleLock(process.argv[4], () => {
            console.log("contender-entered");
          }, { stateDir: process.argv[5] }),
        );
      `,
          new URL("../../state/portable-uninstall-retirement.ts", import.meta.url).href,
          new URL("../../state/mcp-lifecycle-lock-acquisition.ts", import.meta.url).href,
          home,
          sandboxName,
          stateDir,
        ],
        { encoding: "utf8", timeout: execTimeout() },
      );
      expect(contender.status, contender.stderr || String(contender.error ?? "")).toBe(0);
      expect(contender.stdout.trim()).toBe("contender-entered");
      expect(cleanup).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      endSession();
      await expect(finish()).rejects.toThrow("exit:0");
      expect(lockHeldDuringCleanup).toBe(false);
      expect(fenceHeldDuringCleanup).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      endSession();
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
