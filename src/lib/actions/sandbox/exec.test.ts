// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { execSandbox, startSandboxExec, workdirMissingMessage } from "./exec";

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
// registry.
describe("execSandbox policy-denial hint wiring (#5978)", () => {
  const START_MS = 1_000_000;
  // Epoch [1000.500] parses to 1000500ms, at/after START so it is "fresh".
  const DENIAL_LINE =
    "[1000.500] [sandbox] [OCSF ] NET:OPEN [MED] DENIED /usr/bin/curl(1) -> example.com:443 [reason:not allowed by any policy]";

  const runExec = async (
    status: number | null,
    probeOutput: string,
    options: {
      error?: Error;
      now?: () => number;
      onRun?: () => void;
      probeError?: Error;
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

describe("startSandboxExec native stream preservation (#11763)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["successful", 0],
    ["failed", 23],
  ])("preserves native stdout, stderr, and exit status for a %s command", async (_label, code) => {
    const stdoutText = `native stdout ${code}\n`;
    const stderrText = `native stderr ${code}\n`;
    let observedStdout = "";
    let observedStderr = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      observedStdout += String(chunk);
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      observedStderr += String(chunk);
      return true;
    });
    const runStreaming = vi.fn(async () => {
      process.stdout.write(stdoutText);
      process.stderr.write(stderrText);
      return {
        outcome: { kind: "completed" as const, exitCode: code },
        release: vi.fn(),
      };
    });
    const probeLogs = vi.fn(() => "");
    let exitCode = Number.NaN;
    const exit = ((value?: number) => {
      exitCode = value ?? 0;
      throw new Error("__exec_exit__");
    }) as (value: number) => never;

    const finish = await startSandboxExec(
      "native-stream-sandbox",
      ["sh", "-c", "printf native"],
      {},
      {
        selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
        commandExecutor: {
          probeDirectory: async () => ({ state: "present" }),
          runStreaming,
        },
        policyHint: {
          attempts: 1,
          enableAudit: vi.fn(),
          env: {},
          probeLogs,
          sleep: async () => {},
        },
        exit,
      },
    );

    await expect(finish()).rejects.toThrow("__exec_exit__");

    expect(runStreaming).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledExactlyOnceWith(stdoutText);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(stderrText);
    expect(observedStdout).toBe(stdoutText);
    expect(observedStderr).toBe(stderrText);
    expect(exitCode).toBe(code);
    expect(probeLogs).toHaveBeenCalledTimes(code === 0 ? 0 : 1);
  });
});
