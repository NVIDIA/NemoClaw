// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const {
  executeGatewaySupervisorAction,
  executeSandboxCommand,
  executeSandboxExecCommand,
  resolveSandboxDashboardPort,
  waitForManagedGatewaySupervisor,
} = requireSource(
  "../../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../../src/lib/actions/sandbox/process-recovery.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waitForManagedGatewaySupervisor", () => {
  const restartingContainerId = "a".repeat(64);
  const restartingContainer = {
    status: 1,
    stdout: "",
    stderr: `Error response from daemon: Container ${restartingContainerId} is restarting, wait until the container is running`,
    managedControlRestartingContainerId: restartingContainerId,
  } as const;

  it("retries a controller probe after status 137 with no output (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({ status: 137, stdout: "", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("stops after two status 137 controller probes with no output (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi.fn(() => ({
      status: 137,
      stdout: "",
      stderr: "",
    }));

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(false);
    expect(requestGatewaySupervisorActionImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("does not retry a status 137 controller probe with diagnostic output (#8726)", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 137,
          stdout: "",
          stderr: "container stopped",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("waits through an exact managed-container restart transition (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce(restartingContainer)
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(requestGatewaySupervisorActionImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("stops after two managed-container restart transitions (#8726)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi.fn(() => restartingContainer);

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(false);
    expect(requestGatewaySupervisorActionImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("does not wait through an unbound Docker restart diagnostic (#8726)", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: restartingContainer.stderr,
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("waits through an exact missing-supervisor startup race", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "SUPERVISOR_NOT_RUNNING",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("waits through exact pending direct control while a clone container appears", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "PRIVILEGED_CONTROL_UNAVAILABLE",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("waits while a new clone gateway is not healthy yet (#7818)", () => {
    const sleepImpl = vi.fn();
    const requestGatewaySupervisorActionImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "GATEWAY_HEALTH_TIMEOUT",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "GATEWAY_PID=4242",
        stderr: "",
      });

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        intervalSeconds: 3,
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl,
        sleepImpl,
      }),
    ).toBe(true);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledWith(3);
  });

  it("does not wait when a health marker includes unclassified output (#7818)", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: "GATEWAY_HEALTH_TIMEOUT\nunexpected detail",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("does not wait through an unclassified supervisor refusal", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: "prefix SUPERVISOR_NOT_RUNNING suffix",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("does not wait through a detailed privileged-control refusal", () => {
    const sleepImpl = vi.fn();

    expect(
      waitForManagedGatewaySupervisor("new-clone", {
        maxAttempts: 2,
        requestGatewaySupervisorActionImpl: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr: "PRIVILEGED_CONTROL_UNAVAILABLE: container identity changed",
        })),
        sleepImpl,
      }),
    ).toBe(false);
    expect(sleepImpl).not.toHaveBeenCalled();
  });
});

describe("executeGatewaySupervisorAction", () => {
  const targetContainerId = "a".repeat(64);

  it("sanitizes a temporarily unavailable direct container into the retry marker", () => {
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget").mockImplementation(() => {
      throw new Error("temporary direct-container discovery detail");
    });
    vi.spyOn(privilegedExec, "isDirectSandboxFallbackUnavailableError").mockReturnValue(true);

    expect(executeGatewaySupervisorAction("new-clone", "probe", 100)).toEqual({
      status: 1,
      stdout: "",
      stderr: "PRIVILEGED_CONTROL_UNAVAILABLE",
    });
  });

  it("keeps other privileged-control refusals terminal and classified", () => {
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget").mockImplementation(() => {
      throw new Error(
        "OpenShell container identity changed for sandbox 'new-clone'; refusing privileged execution against a different container.",
      );
    });
    vi.spyOn(privilegedExec, "isDirectSandboxFallbackUnavailableError").mockReturnValue(false);

    expect(executeGatewaySupervisorAction("new-clone", "probe", 100)).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "PRIVILEGED_CONTROL_UNAVAILABLE: OpenShell container identity changed for sandbox 'new-clone'; refusing privileged execution against a different container.",
    });
  });

  it("emits the managed-control identity marker for a pinned container refusal (#9364)", () => {
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget").mockImplementation(() => {
      throw new Error(
        "OpenShell container identity changed for sandbox 'new-clone'; refusing privileged execution against a different container.",
      );
    });
    vi.spyOn(privilegedExec, "isDirectSandboxFallbackUnavailableError").mockReturnValue(false);
    vi.spyOn(privilegedExec, "isPinnedSandboxContainerIdentityChangedError").mockReturnValue(true);

    expect(executeGatewaySupervisorAction("new-clone", "probe", 100)).toEqual({
      status: 1,
      stdout: "",
      stderr:
        "MANAGED_CONTROL_IDENTITY_CHANGED\nOpenShell container identity changed for sandbox 'new-clone'; refusing privileged execution against a different container.",
    });
  });

  it("binds an exact Docker restart transition to the selected container (#8726)", () => {
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget").mockReturnValue({
      resourceHandle: targetContainerId,
    });
    vi.spyOn(privilegedExec, "executePrivilegedSandboxCommand").mockReturnValue({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        `Error response from daemon: Container ${targetContainerId} is restarting, wait until the container is running`,
      ),
    } as never);

    expect(executeGatewaySupervisorAction("new-clone", "probe", 100)).toEqual({
      status: 1,
      stdout: "",
      stderr: `Error response from daemon: Container ${targetContainerId} is restarting, wait until the container is running`,
      managedControlRestartingContainerId: targetContainerId,
    });
  });

  it.each([
    ["an error for a different container", 1, "", "b".repeat(64), ""],
    ["a status-2 error", 2, "", targetContainerId, ""],
    ["a result with stdout", 1, "unexpected", targetContainerId, ""],
    ["an error with an additional line", 1, "", targetContainerId, "\nunexpected"],
  ])(
    "does not bind %s as a Docker restart transition (#8726)",
    (_case, status, stdout, id, suffix) => {
      const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
      vi.spyOn(privilegedExec, "resolvePrivilegedSandboxTarget").mockReturnValue({
        resourceHandle: targetContainerId,
      });
      vi.spyOn(privilegedExec, "executePrivilegedSandboxCommand").mockReturnValue({
        status,
        signal: null,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(
          `Error response from daemon: Container ${id} is restarting, wait until the container is running${suffix}`,
        ),
      } as never);

      expect(executeGatewaySupervisorAction("new-clone", "probe", 100)).toEqual({
        status,
        stdout,
        stderr: `Error response from daemon: Container ${id} is restarting, wait until the container is running${suffix}`,
      });
    },
  );
});

function withFakeOpenshellBinary<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
  const bin = path.join(dir, "openshell");
  const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.NEMOCLAW_OPENSHELL_BIN = bin;
  try {
    return fn();
  } finally {
    previous === undefined
      ? delete process.env.NEMOCLAW_OPENSHELL_BIN
      : (process.env.NEMOCLAW_OPENSHELL_BIN = previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveSandboxDashboardPort", () => {
  it("uses the recorded OpenClaw dashboard port for multi-sandbox recovery", () => {
    expect(
      resolveSandboxDashboardPort("beta", {
        getSessionAgent: () => null,
        getSandbox: () => ({ name: "beta", dashboardPort: 18790 }),
      }),
    ).toBe(18790);
  });

  it("falls back to the default OpenClaw dashboard port when registry metadata is absent", () => {
    expect(
      resolveSandboxDashboardPort("legacy", {
        getSessionAgent: () => null,
        getSandbox: () => null,
      }),
    ).toBe(18789);
  });

  it("keeps non-OpenClaw agents on their recorded custom dashboard port (#6277)", () => {
    expect(
      resolveSandboxDashboardPort("hermes-box", {
        getSessionAgent: () => ({ forwardPort: 8642 }),
        getSandbox: () => ({ name: "hermes-box", dashboardPort: 18790 }),
      }),
    ).toBe(18790);
  });

  it("falls back to a non-OpenClaw agent's declared port without registry metadata", () => {
    expect(
      resolveSandboxDashboardPort("hermes-box", {
        getSessionAgent: () => ({ forwardPort: 8642 }),
        getSandbox: () => null,
      }),
    ).toBe(8642);
  });

  it("does not invent a dashboard port for terminal agents without declared forwards", () => {
    expect(
      resolveSandboxDashboardPort("terminal-box", {
        getSessionAgent: () => ({ runtime: { kind: "terminal" } }),
        getSandbox: () => ({ name: "terminal-box", dashboardPort: 18790 }),
      }),
    ).toBe(18790);
  });

  it("ignores invalid agent forward ports and falls back to registry metadata", () => {
    expect(
      resolveSandboxDashboardPort("beta", {
        getSessionAgent: () => ({ forwardPort: 0 }),
        getSandbox: () => ({ name: "beta", dashboardPort: 18790 }),
      }),
    ).toBe(18790);
  });
});

describe("executeSandboxExecCommand", () => {
  it("does not forward an MCP credential to the OpenShell child process", () => {
    const childProcess = requireSource("node:child_process");
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nREADY\n",
      stderr: "",
    } as never);
    const priorSecret = process.env.TEST_MCP_RAW_TOKEN;
    const priorGateway = process.env.OPENSHELL_GATEWAY;
    process.env.TEST_MCP_RAW_TOKEN = "must-reach-only-provider-mutation";
    process.env.OPENSHELL_GATEWAY = "nemoclaw-19080";

    try {
      const result = withFakeOpenshellBinary(() =>
        executeSandboxExecCommand("hermes-box", "printf READY"),
      );
      const options = spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };

      expect(result).toEqual({ status: 0, stdout: "READY", stderr: "" });
      expect(options.env?.TEST_MCP_RAW_TOKEN).toBeUndefined();
      expect(options.env?.OPENSHELL_GATEWAY).toBe("nemoclaw-19080");
      expect(options.env?.PATH).toBe(process.env.PATH);
    } finally {
      priorSecret === undefined
        ? delete process.env.TEST_MCP_RAW_TOKEN
        : (process.env.TEST_MCP_RAW_TOKEN = priorSecret);
      priorGateway === undefined
        ? delete process.env.OPENSHELL_GATEWAY
        : (process.env.OPENSHELL_GATEWAY = priorGateway);
    }
  });

  it("honors the sandbox-exec timeout without falling back to SSH", () => {
    const childProcess = requireSource("node:child_process");
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: null,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\n",
      stderr: "",
      error: timeoutError,
    } as never);
    const executePrivileged = vi
      .spyOn(privilegedExec, "executePrivilegedSandboxCommand")
      .mockReturnValue({
        status: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: timeoutError,
      } as never);
    const previousTimeout = process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS;
    process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS = "50";

    try {
      const result = withFakeOpenshellBinary(() =>
        executeSandboxExecCommand("alpha", "printf RUNNING"),
      );

      expect(result).toBeNull();
      expect(spawn.mock.calls.some(([command]) => command === "ssh")).toBe(false);
      expect(spawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ timeout: 50 }));
      expect(executePrivileged.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ sanitizeEnvironment: true, timeout: 50 }),
      );
    } finally {
      previousTimeout === undefined
        ? delete process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS
        : (process.env.NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS = previousTimeout);
    }
  });

  it("parses stdout-framed root exec output after the startup marker", () => {
    const childProcess = requireSource("node:child_process");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: [
        "OpenShell sandbox exec output:",
        "stdout: __NEMOCLAW_SANDBOX_EXEC_STARTED__",
        "stdout: SECRET_BOUNDARY_OK",
      ].join("\n"),
      stderr: "",
    } as never);

    const result = withFakeOpenshellBinary(() =>
      executeSandboxExecCommand("hermes-box", "echo SECRET_BOUNDARY_OK"),
    );

    expect(result).toEqual({ status: 0, stdout: "SECRET_BOUNDARY_OK", stderr: "" });
  });

  it("rejects a non-frame preamble and surfaces a missing trusted fallback identity", () => {
    const childProcess = requireSource("node:child_process");
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: [
        "operator preamble mentions __NEMOCLAW_SANDBOX_EXEC_STARTED__ before child stdout",
        "stdout: RUNNING",
      ].join("\n"),
      stderr: "",
    } as never);
    const executePrivileged = vi.spyOn(privilegedExec, "executePrivilegedSandboxCommand");

    expect(() =>
      withFakeOpenshellBinary(() => executeSandboxExecCommand("hermes-box", "echo RUNNING")),
    ).toThrow(/No NemoClaw registry entry found.*refusing privileged exec/);
    expect(executePrivileged).toHaveBeenCalledTimes(1);
  });

  it("keeps the Hermes validator source out of the host shell payload", () => {
    const childProcess = requireSource("node:child_process");
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSECRET_BOUNDARY_OK\n",
      stderr: "",
    } as never);

    const result = withFakeOpenshellBinary(() =>
      executeSandboxExecCommand(
        "hermes-box",
        "python3 /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py env-file /sandbox/.hermes/.env\necho SECRET_BOUNDARY_OK",
      ),
    );

    const args = spawn.mock.calls[0]?.[1] as string[];
    const shellPayload = args.at(-1) ?? "";
    expect(result).toEqual({ status: 0, stdout: "SECRET_BOUNDARY_OK", stderr: "" });
    expect(shellPayload).toContain("printf '%s\\n' '__NEMOCLAW_SANDBOX_EXEC_STARTED__'");
    expect(shellPayload).toContain("base64 -d | sh");
    expect(shellPayload).not.toContain("echo SECRET_BOUNDARY_OK");
  });

  it("falls back to local Docker root exec when OpenShell exec output has no marker", () => {
    const childProcess = requireSource("node:child_process");
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "OpenShell transport preamble\n",
      stderr: "",
    } as never);
    const executePrivileged = vi
      .spyOn(privilegedExec, "executePrivilegedSandboxCommand")
      .mockReturnValue({
        status: 0,
        signal: null,
        stdout: Buffer.from("__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSECRET_BOUNDARY_OK\n"),
        stderr: Buffer.alloc(0),
      } as never);

    const priorSecret = process.env.TEST_MCP_RAW_TOKEN;
    const priorGateway = process.env.OPENSHELL_GATEWAY;
    process.env.TEST_MCP_RAW_TOKEN = "must-reach-only-provider-mutation";
    process.env.OPENSHELL_GATEWAY = "nemoclaw-19080";
    const result = withFakeOpenshellBinary(() =>
      executeSandboxExecCommand("hermes-box", "echo SECRET_BOUNDARY_OK"),
    );
    priorSecret === undefined
      ? delete process.env.TEST_MCP_RAW_TOKEN
      : (process.env.TEST_MCP_RAW_TOKEN = priorSecret);
    priorGateway === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = priorGateway);

    expect(result).toEqual({ status: 0, stdout: "SECRET_BOUNDARY_OK", stderr: "" });
    expect(executePrivileged).toHaveBeenCalledWith(
      "hermes-box",
      ["sh", "-c", expect.stringContaining("echo SECRET_BOUNDARY_OK")],
      expect.objectContaining({ sanitizeEnvironment: true }),
    );
  });

  it("does not let Docker fallback satisfy a strict provider credential proof", () => {
    const childProcess = requireSource("node:child_process");
    const privilegedExec = requireSource("../../src/lib/sandbox/privileged-exec.ts");
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 1,
      stdout: "OpenShell transport failed before the child marker\n",
      stderr: "gateway unavailable\n",
    } as never);
    const executePrivileged = vi.spyOn(privilegedExec, "executePrivilegedSandboxCommand");

    const result = withFakeOpenshellBinary(() =>
      executeSandboxExecCommand("hermes-box", '[ -z "${FAKE_MCP_SECRET+x}" ]', undefined, {
        allowLocalDockerFallback: false,
      }),
    );

    expect(result).toBeNull();
    expect(executePrivileged).not.toHaveBeenCalled();
    const args = spawn.mock.calls[0]?.[1] as string[];
    const shellPayload = args.at(-1) ?? "";
    expect(shellPayload).not.toMatch(/[\r\n]/);
    expect(shellPayload).toContain("printf '%s\\n' '__NEMOCLAW_SANDBOX_EXEC_STARTED__'");
  });
});

describe("executeSandboxCommand", () => {
  it("does not forward an MCP credential to the SSH child process", () => {
    const openshellRuntime = requireSource("../../src/lib/adapters/openshell/runtime.ts");
    const childProcess = requireSource("node:child_process");
    vi.spyOn(openshellRuntime, "captureSandboxSshConfig").mockReturnValue({
      status: 0,
      output: "Host openshell-alpha\n  HostName 127.0.0.1\n",
    } as never);
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "registered\n",
      stderr: "",
    } as never);
    const priorSecret = process.env.TEST_MCP_RAW_TOKEN;
    const priorGateway = process.env.OPENSHELL_GATEWAY;
    process.env.TEST_MCP_RAW_TOKEN = "must-reach-only-provider-mutation";
    process.env.OPENSHELL_GATEWAY = "nemoclaw-19080";

    try {
      expect(executeSandboxCommand("alpha", "mcporter config get fake --json")).toEqual({
        status: 0,
        stdout: "registered",
        stderr: "",
      });
      const options = spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(options.env?.TEST_MCP_RAW_TOKEN).toBeUndefined();
      expect(options.env?.OPENSHELL_GATEWAY).toBe("nemoclaw-19080");
      expect(options.env?.PATH).toBe(process.env.PATH);
    } finally {
      priorSecret === undefined
        ? delete process.env.TEST_MCP_RAW_TOKEN
        : (process.env.TEST_MCP_RAW_TOKEN = priorSecret);
      priorGateway === undefined
        ? delete process.env.OPENSHELL_GATEWAY
        : (process.env.OPENSHELL_GATEWAY = priorGateway);
    }
  });
});
