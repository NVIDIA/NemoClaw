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
  classifyForwardHealthWithReachability,
  classifySandboxForwardHealth,
  executeSandboxCommand,
  executeSandboxExecCommand,
  resolveSandboxDashboardPort,
} = requireSource(
  "../src/lib/actions/sandbox/process-recovery.ts",
) as typeof import("../src/lib/actions/sandbox/process-recovery.js");

afterEach(() => {
  vi.restoreAllMocks();
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

describe("classifySandboxForwardHealth", () => {
  it("returns true for a running forward owned by the target sandbox", () => {
    expect(
      classifySandboxForwardHealth(
        [{ sandboxName: "beta", port: "18790", status: "running" }],
        "beta",
        "18790",
      ),
    ).toBe(true);
  });

  it("returns occupied when another sandbox owns the expected port", () => {
    expect(
      classifySandboxForwardHealth(
        [{ sandboxName: "alpha", port: "18790", status: "running" }],
        "beta",
        "18790",
      ),
    ).toBe("occupied");
  });

  it("returns false for a missing forward", () => {
    expect(classifySandboxForwardHealth([], "beta", "18790")).toBe(false);
  });

  it("returns false for a non-running forward owned by the target sandbox", () => {
    expect(
      classifySandboxForwardHealth(
        [{ sandboxName: "beta", port: "18790", status: "dead" }],
        "beta",
        "18790",
      ),
    ).toBe(false);
  });

  it("finds a live target entry after a stale duplicate for the same port", () => {
    expect(
      classifySandboxForwardHealth(
        [
          { sandboxName: "beta", port: "18790", status: "dead" },
          { sandboxName: "beta", port: "18790", status: "running" },
        ],
        "beta",
        "18790",
      ),
    ).toBe(true);
  });

  it("returns occupied when a foreign live entry conflicts with the live target", () => {
    expect(
      classifySandboxForwardHealth(
        [
          { sandboxName: "beta", port: "18790", status: "running" },
          { sandboxName: "alpha", port: "18790", status: "running" },
        ],
        "beta",
        "18790",
      ),
    ).toBe("occupied");
  });

  it("ignores a stale foreign entry when the target owns the live forward", () => {
    expect(
      classifySandboxForwardHealth(
        [
          { sandboxName: "alpha", port: "18790", status: "dead" },
          { sandboxName: "beta", port: "18790", status: "running" },
        ],
        "beta",
        "18790",
      ),
    ).toBe(true);
  });
});

describe("classifyForwardHealthWithReachability", () => {
  it("does not trust an arbitrary local listener for a non-running owned entry", () => {
    let probed = false;
    const result = classifyForwardHealthWithReachability(
      [{ sandboxName: "beta", port: "18790", status: "dead" }],
      "beta",
      "18790",
      () => {
        probed = true;
        return true;
      },
    );

    expect(result).toBe(false);
    expect(probed).toBe(false);
  });

  it("does not accept reachability when the forward list entry is missing", () => {
    expect(classifyForwardHealthWithReachability([], "beta", "18790", () => true)).toBe(false);
  });

  it("returns false when forward list says dead and the port does not answer", () => {
    expect(
      classifyForwardHealthWithReachability(
        [{ sandboxName: "beta", port: "18790", status: "dead" }],
        "beta",
        "18790",
        () => false,
      ),
    ).toBe(false);
  });

  it("returns false when an owned running row no longer answers", () => {
    let probed = false;
    const result = classifyForwardHealthWithReachability(
      [{ sandboxName: "beta", port: "18790", status: "running" }],
      "beta",
      "18790",
      () => {
        probed = true;
        return false;
      },
    );
    expect(result).toBe(false);
    expect(probed).toBe(true);
  });

  it("returns occupied even when the port answers if another sandbox owns it", () => {
    // Reachability says yes, but the entry belongs to a different sandbox —
    // we must not silently take over someone else's forward.
    expect(
      classifyForwardHealthWithReachability(
        [{ sandboxName: "alpha", port: "18790", status: "running" }],
        "beta",
        "18790",
        () => true,
      ),
    ).toBe("occupied");
  });

  it("requires a live duplicate after a stale target entry to answer", () => {
    let probed = false;
    const result = classifyForwardHealthWithReachability(
      [
        { sandboxName: "beta", port: "18790", status: "dead" },
        { sandboxName: "beta", port: "18790", status: "running" },
      ],
      "beta",
      "18790",
      () => {
        probed = true;
        return true;
      },
    );

    expect(result).toBe(true);
    expect(probed).toBe(true);
  });

  it("returns occupied for a foreign live duplicate even when the target also has a live row", () => {
    expect(
      classifyForwardHealthWithReachability(
        [
          { sandboxName: "beta", port: "18790", status: "running" },
          { sandboxName: "alpha", port: "18790", status: "running" },
        ],
        "beta",
        "18790",
        () => true,
      ),
    ).toBe("occupied");
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
    const dockerExec = requireSource("../src/lib/adapters/docker/exec.ts");
    const privilegedExec = requireSource("../src/lib/sandbox/privileged-exec.ts");
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: null,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\n",
      stderr: "",
      error: timeoutError,
    } as never);
    vi.spyOn(privilegedExec, "privilegedSandboxExecArgv").mockReturnValue([
      "exec",
      "--user",
      "root",
      "openshell-alpha",
      "sh",
      "-c",
      "marked-command",
    ]);
    const dockerSpawnSync = vi.spyOn(dockerExec, "dockerSpawnSync").mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
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
      expect(dockerSpawnSync.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ timeout: 50 }));
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
    const dockerExec = requireSource("../src/lib/adapters/docker/exec.ts");
    const privilegedExec = requireSource("../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: [
        "operator preamble mentions __NEMOCLAW_SANDBOX_EXEC_STARTED__ before child stdout",
        "stdout: RUNNING",
      ].join("\n"),
      stderr: "",
    } as never);
    const privilegedArgv = vi.spyOn(privilegedExec, "privilegedSandboxExecArgv");
    const dockerSpawnSync = vi.spyOn(dockerExec, "dockerSpawnSync");

    expect(() =>
      withFakeOpenshellBinary(() => executeSandboxExecCommand("hermes-box", "echo RUNNING")),
    ).toThrow(/No NemoClaw registry entry found.*refusing privileged exec/);
    expect(privilegedArgv).toHaveBeenCalledTimes(1);
    expect(dockerSpawnSync).not.toHaveBeenCalled();
  });

  it("passes a newline-free Hermes validator payload to OpenShell", () => {
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
    expect(shellPayload.includes("\n")).toBe(false);
    expect(shellPayload.includes("\r")).toBe(false);
    expect(shellPayload).toContain("printf '%s\\n' '__NEMOCLAW_SANDBOX_EXEC_STARTED__'");
    expect(shellPayload).toContain("base64 -d | sh");
  });

  it("falls back to local Docker root exec when OpenShell exec output has no marker", () => {
    const childProcess = requireSource("node:child_process");
    const dockerExec = requireSource("../src/lib/adapters/docker/exec.ts");
    const privilegedExec = requireSource("../src/lib/sandbox/privileged-exec.ts");
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "OpenShell transport preamble\n",
      stderr: "",
    } as never);
    const privilegedArgv = vi
      .spyOn(privilegedExec, "privilegedSandboxExecArgv")
      .mockReturnValue([
        "exec",
        "--user",
        "root",
        "openshell-hermes-box-generated",
        "sh",
        "-c",
        "marked-command",
      ]);
    const dockerSpawnSync = vi.spyOn(dockerExec, "dockerSpawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nSECRET_BOUNDARY_OK\n",
      stderr: "",
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
    expect(privilegedArgv).toHaveBeenCalledWith("hermes-box", [
      "sh",
      "-c",
      expect.stringContaining("echo SECRET_BOUNDARY_OK"),
    ]);
    expect(dockerSpawnSync.mock.calls[0]?.[0]).toEqual([
      "exec",
      "--user",
      "root",
      "openshell-hermes-box-generated",
      "sh",
      "-c",
      "marked-command",
    ]);
    const dockerOptions = dockerSpawnSync.mock.calls[0]?.[1] as { env?: NodeJS.ProcessEnv };
    expect(dockerOptions.env?.TEST_MCP_RAW_TOKEN).toBeUndefined();
    expect(dockerOptions.env?.OPENSHELL_GATEWAY).toBe("nemoclaw-19080");
    expect(dockerOptions.env?.PATH).toBe(process.env.PATH);
  });

  it("does not let Docker fallback satisfy a strict provider credential proof", () => {
    const childProcess = requireSource("node:child_process");
    const dockerExec = requireSource("../src/lib/adapters/docker/exec.ts");
    const privilegedExec = requireSource("../src/lib/sandbox/privileged-exec.ts");
    const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 1,
      stdout: "OpenShell transport failed before the child marker\n",
      stderr: "gateway unavailable\n",
    } as never);
    const privilegedArgv = vi.spyOn(privilegedExec, "privilegedSandboxExecArgv");
    const dockerSpawnSync = vi.spyOn(dockerExec, "dockerSpawnSync");

    const result = withFakeOpenshellBinary(() =>
      executeSandboxExecCommand("hermes-box", '[ -z "${FAKE_MCP_SECRET+x}" ]', undefined, {
        allowLocalDockerFallback: false,
      }),
    );

    expect(result).toBeNull();
    expect(privilegedArgv).not.toHaveBeenCalled();
    expect(dockerSpawnSync).not.toHaveBeenCalled();
    const args = spawn.mock.calls[0]?.[1] as string[];
    const shellPayload = args.at(-1) ?? "";
    expect(shellPayload).not.toMatch(/[\r\n]/);
    expect(shellPayload).toContain("printf '%s\\n' '__NEMOCLAW_SANDBOX_EXEC_STARTED__'");
  });
});

describe("executeSandboxCommand", () => {
  it("does not forward an MCP credential to the SSH child process", () => {
    const openshellRuntime = requireSource("../src/lib/adapters/openshell/runtime.ts");
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
