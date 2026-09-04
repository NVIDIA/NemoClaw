// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

// Multi-line command argv dispatch and field-specific rejection coverage lives
// in exec.multiline-argv.test.ts so this file stays focused on argv construction
// and the workdir probe.
import {
  buildOpenshellExecArgs,
  buildWorkdirProbeArgs,
  computeExitCode,
  evaluateWorkdirProbe,
  execSandbox,
  runSandboxExecChild,
  type SandboxExecChild,
  type SandboxExecCleanupDeps,
  type SandboxExecSignalSource,
  validateWorkdirOrFail,
  workdirMissingMessage,
} from "./exec";

function completedSpawnChild(status = 0): SandboxExecChild {
  const child = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    once: vi.fn((event: "error" | "close", listener: (...args: unknown[]) => void) => {
      const notify = {
        error: () => undefined,
        close: () => queueMicrotask(() => listener(status, null)),
      }[event];
      notify();
      return child;
    }),
  };
  return child as unknown as SandboxExecChild;
}

const signalSource: SandboxExecSignalSource = {
  add: vi.fn(),
  remove: vi.fn(),
};

describe("runSandboxExecChild spawn options", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.mocked(signalSource.add).mockClear();
    vi.mocked(signalSource.remove).mockClear();
  });

  it("forwards a supplied subprocess environment to spawn unchanged", async () => {
    const subprocessEnv = { HOME: "/home/test", PATH: "/usr/bin" };
    spawnMock.mockReturnValueOnce(completedSpawnChild());

    const result = await runSandboxExecChild(
      "/usr/bin/openshell",
      ["sandbox", "list"],
      { stdin: false, subprocessEnv },
      undefined,
      signalSource,
    );
    result.releaseSignals?.();

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "list"],
      expect.objectContaining({
        env: subprocessEnv,
        stdio: ["ignore", "inherit", "inherit"],
      }),
    );
    expect(spawnMock.mock.calls[0]?.[2]?.env).toBe(subprocessEnv);
  });

  it("preserves the existing spawn options when subprocessEnv is absent", async () => {
    spawnMock.mockReturnValueOnce(completedSpawnChild());

    const result = await runSandboxExecChild(
      "/usr/bin/openshell",
      ["sandbox", "list"],
      { stdin: false },
      undefined,
      signalSource,
    );
    result.releaseSignals?.();

    expect(spawnMock).toHaveBeenCalledWith("/usr/bin/openshell", ["sandbox", "list"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty("env");
  });
});

describe("buildOpenshellExecArgs", () => {
  it("targets the sandbox by name and forwards the user command after --", () => {
    expect(
      buildOpenshellExecArgs("my-assistant", ["openclaw", "agent", "--agent", "main", "-m", "hi"]),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "my-assistant",
      "--",
      "openclaw",
      "agent",
      "--agent",
      "main",
      "-m",
      "hi",
    ]);
  });

  it("places --workdir before the command separator", () => {
    expect(
      buildOpenshellExecArgs("alpha", ["ls", "-la"], { workdir: "/sandbox/workspace" }),
    ).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--workdir",
      "/sandbox/workspace",
      "--",
      "ls",
      "-la",
    ]);
  });

  it("emits --tty when tty is explicitly true and --no-tty when false", () => {
    expect(buildOpenshellExecArgs("alpha", ["hostname"], { tty: true })).toContain("--tty");
    expect(buildOpenshellExecArgs("alpha", ["hostname"], { tty: false })).toContain("--no-tty");
  });

  it("omits the tty flag entirely when tty is null or undefined (auto-detect)", () => {
    const auto = buildOpenshellExecArgs("alpha", ["hostname"], { tty: null });
    expect(auto).not.toContain("--tty");
    expect(auto).not.toContain("--no-tty");
    const omitted = buildOpenshellExecArgs("alpha", ["hostname"]);
    expect(omitted).not.toContain("--tty");
    expect(omitted).not.toContain("--no-tty");
  });

  it("forwards --timeout as a stringified integer", () => {
    expect(buildOpenshellExecArgs("alpha", ["sleep", "1"], { timeoutSeconds: 30 })).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--timeout",
      "30",
      "--",
      "sleep",
      "1",
    ]);
  });

  it("preserves an empty user command (caller is responsible for guarding)", () => {
    expect(buildOpenshellExecArgs("alpha", [])).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
    ]);
  });

  it("does not interpolate the sandbox name into argv strings", () => {
    const argv = buildOpenshellExecArgs("name; rm -rf /", ["echo", "ok"]);
    expect(argv).toContain("name; rm -rf /");
    expect(argv).toEqual(["sandbox", "exec", "--name", "name; rm -rf /", "--", "echo", "ok"]);
  });
});

describe("computeExitCode", () => {
  it("returns the remote command's status when it exits normally", () => {
    expect(computeExitCode({ status: 0 })).toEqual({ code: 0 });
    expect(computeExitCode({ status: 42 })).toEqual({ code: 42 });
  });

  it("surfaces spawn transport errors with the error message and code 1", () => {
    const error = new Error("openshell: command not found");
    expect(computeExitCode({ status: null, error })).toEqual({
      code: 1,
      errorMessage: "openshell: command not found",
    });
  });
});

describe("buildWorkdirProbeArgs", () => {
  it("targets the sandbox by name and probes the directory with test -d", () => {
    expect(buildWorkdirProbeArgs("alpha", "/sandbox/workspace")).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "test",
      "-d",
      "/sandbox/workspace",
    ]);
  });

  it("does not split a path argument that contains whitespace", () => {
    const argv = buildWorkdirProbeArgs("alpha", "/sandbox/with spaces/dir");
    expect(argv[argv.length - 1]).toBe("/sandbox/with spaces/dir");
  });
});

describe("workdirMissingMessage", () => {
  it("renders a user-facing CLI error with the offending path", () => {
    expect(workdirMissingMessage("/sandbox/workspace")).toBe(
      "error: --workdir: /sandbox/workspace does not exist inside the sandbox",
    );
  });
});

describe("evaluateWorkdirProbe", () => {
  it("returns 'ok' when the probe exits 0", () => {
    expect(evaluateWorkdirProbe({ status: 0 })).toBe("ok");
  });

  it("returns 'missing' only for the canonical test -d failure (exit 1)", () => {
    expect(evaluateWorkdirProbe({ status: 1 })).toBe("missing");
  });

  it("returns 'unclear' for any other exit code so the main exec surfaces it", () => {
    expect(evaluateWorkdirProbe({ status: 2 })).toBe("unclear");
    expect(evaluateWorkdirProbe({ status: 127 })).toBe("unclear");
    expect(evaluateWorkdirProbe({ status: null })).toBe("unclear");
  });

  it("returns 'unclear' when spawn reports a transport error", () => {
    expect(evaluateWorkdirProbe({ status: null, error: new Error("ENOENT") })).toBe("unclear");
  });
});

describe("validateWorkdirOrFail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through when the directory exists", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit should not be called for ok outcome");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    validateWorkdirOrFail("openshell", "alpha", "/sandbox/workspace", run);

    expect(run).toHaveBeenCalledWith("openshell", [
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "test",
      "-d",
      "/sandbox/workspace",
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("prints a friendly error and exits 1 when the directory is missing", () => {
    const run = vi.fn(() => ({ status: 1 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => validateWorkdirOrFail("openshell", "alpha", "/sandbox/workspace", run)).toThrow(
      "exit",
    );
    expect(errSpy).toHaveBeenCalledWith(
      "error: --workdir: /sandbox/workspace does not exist inside the sandbox",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not abort when the probe outcome is unclear (lets main exec surface it)", () => {
    const run = vi.fn(() => ({ status: 127 }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit should not be called for unclear outcome");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    validateWorkdirOrFail("openshell", "alpha", "/sandbox/workspace", run);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
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
        resolveBinary: () => "openshell",
        selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
        run: async () => {
          options.onRun?.();
          return { status, ...(options.error ? { error: options.error } : {}) };
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
        applies: false,
        skipReason: "unavailable",
        reason: "container unavailable",
      })
      .mockReturnValueOnce({
        applies: true,
        ok: true,
        dirMode: "2770",
        dirOwner: "sandbox:sandbox",
        fileMode: "660",
        fileOwner: "sandbox:sandbox",
        configDir: "/sandbox/.openclaw",
        configFile: "openclaw.json",
        issues: [],
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
    expect(inspectMutableConfigPerms).toHaveBeenCalledTimes(2);
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
        resolveBinary: () => "openshell",
        selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
        run: async () => ({ status }),
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

  it("names the review command and preserves the exit code when a request is pending", async () => {
    const { exitCode, stderr } = await runOpenClawExec(1, UNRELATED_ADMIN_PENDING);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("nemoclaw wire-sbx exec -- openclaw devices list");
  });

  it.each([
    ["the uncorrelated request id", "c0ffee00-dead-4beef-b0bb-000000000001"],
    ["the requested scopes", "operator.admin"],
    ["the requesting device", "unrelated-device-fingerprint"],
  ])("never presents %s as this command's remedy", async (_label, leaked) => {
    const { stderr } = await runOpenClawExec(1, UNRELATED_ADMIN_PENDING);
    expect(stderr).toContain("openclaw devices approve <requestId>");
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
