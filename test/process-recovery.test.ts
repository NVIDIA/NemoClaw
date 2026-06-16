// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAndRecoverSandboxProcesses,
  classifyForwardHealthWithReachability,
  classifySandboxForwardHealth,
  resolveSandboxDashboardPort,
  type SandboxForwardListEntry,
} from "../dist/lib/actions/sandbox/process-recovery.js";

const requireDist = createRequire(import.meta.url);

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
    if (previous === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = previous;
    }
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

  it("keeps non-OpenClaw agents on their declared forward port", () => {
    expect(
      resolveSandboxDashboardPort("hermes-box", {
        getSessionAgent: () => ({ forwardPort: 8642 }),
        getSandbox: () => ({ name: "hermes-box", dashboardPort: 18790 }),
      }),
    ).toBe(8642);
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
});

describe("classifyForwardHealthWithReachability", () => {
  // Regression coverage for #3334: `openshell forward list` STATUS can lag the
  // real state of the forward. When it shows a non-running entry but the
  // local port still answers, the forward is functionally healthy and the
  // probe must not trigger spurious "missing or dead" + "Failed to
  // re-establish" log pairs.
  it("treats a non-running entry as healthy when the local port answers", () => {
    // Covers both branches that produce `false` from the underlying classifier:
    // a missing entry, and an entry whose status is anything but "running".
    const inputs: SandboxForwardListEntry[][] = [
      [],
      [{ sandboxName: "beta", port: "18790", status: "dead" }],
    ];
    for (const entries of inputs) {
      expect(classifyForwardHealthWithReachability(entries, "beta", "18790", () => true)).toBe(
        true,
      );
    }
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

  it("returns true without probing when forward list already reports running", () => {
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
    expect(result).toBe(true);
    expect(probed).toBe(false);
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
});

describe("checkAndRecoverSandboxProcesses", () => {
  it("scopes forward stop to the target sandbox when restarting a dead forward", () => {
    const openshellRuntime = requireDist("../dist/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireDist("../dist/lib/agent/runtime.js");
    const registry = requireDist("../dist/lib/state/registry.js");
    const forwardHealth = requireDist("../dist/lib/actions/sandbox/forward-health.js");
    const childProcess = requireDist("node:child_process");
    const deadForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  dead`;
    const runningForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`;
    let forwardListCalls = 0;

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "beta",
      agent: "openclaw",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(false);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs : [];
      expect(args).toEqual(["forward", "list"]);
      forwardListCalls += 1;
      return {
        status: 0,
        output: forwardListCalls >= 3 ? runningForward : deadForward,
      };
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: true,
    });
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "beta"], {
      ignoreError: true,
      stdio: "ignore",
    });
    expect(
      runOpenshell.mock.calls.some(
        ([args]) =>
          Array.isArray(args) && args[0] === "forward" && args[1] === "stop" && args.length === 3,
      ),
    ).toBe(false);
  });

  it("waits for a recovered sandbox gateway before declaring recovery", () => {
    const openshellRuntime = requireDist("../dist/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireDist("../dist/lib/agent/runtime.js");
    const registry = requireDist("../dist/lib/state/registry.js");
    const childProcess = requireDist("node:child_process");
    const runningForward = `SANDBOX  BIND  PORT  PID  STATUS
beta  127.0.0.1  18789  12345  running`;
    const previousWaitSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
    const previousPollInterval = process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS;
    const previousSettleSeconds = process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
    let healthProbeCalls = 0;

    process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = "2";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = "0";
    process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = "0";

    try {
      vi.spyOn(childProcess, "spawnSync").mockImplementation(
        (_command: unknown, rawArgs: unknown) => {
          const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
          const shellCommand = String(args.at(-1) ?? "");
          if (shellCommand.includes("HTTP_CODE=$(curl")) {
            healthProbeCalls += 1;
            const status = healthProbeCalls >= 3 ? "RUNNING" : "STOPPED";
            return {
              status: 0,
              stdout: `__NEMOCLAW_SANDBOX_EXEC_STARTED__\n${status}\n`,
              stderr: "",
            } as never;
          }
          return {
            status: 0,
            stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nGATEWAY_PID=123\n",
            stderr: "",
          } as never;
        },
      );
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "beta",
        agent: "openclaw",
        dashboardPort: 18789,
      });
      vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
        status: 0,
        output: runningForward,
      });

      expect(
        withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("beta", { quiet: true })),
      ).toEqual({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
      });
      expect(healthProbeCalls).toBe(3);
    } finally {
      if (previousWaitSeconds === undefined)
        delete process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS;
      else process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS = previousWaitSeconds;
      if (previousPollInterval === undefined) {
        delete process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS;
      } else {
        process.env.NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS = previousPollInterval;
      }
      if (previousSettleSeconds === undefined) {
        delete process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS;
      } else {
        process.env.NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS = previousSettleSeconds;
      }
    }
  });

  it("re-establishes manifest-declared non-primary forward ports when only the primary is healthy", () => {
    const openshellRuntime = requireDist("../dist/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireDist("../dist/lib/agent/runtime.js");
    const registry = requireDist("../dist/lib/state/registry.js");
    const forwardHealth = requireDist("../dist/lib/actions/sandbox/forward-health.js");
    const childProcess = requireDist("node:child_process");
    const onlyPrimaryForward = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running`;
    const bothForwards = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running
hermes-box  127.0.0.1  8642  12346  running`;
    let secondaryStarted = false;

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      forward_ports: [18789, 8642],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation((port: unknown) => {
      if (Number(port) === 18789) return true;
      if (Number(port) === 8642) return secondaryStarted;
      return false;
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(() => ({
      status: 0,
      output: secondaryStarted ? bothForwards : onlyPrimaryForward,
    }));
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockImplementation((rawArgs: unknown) => {
        const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
        if (args[0] === "forward" && args[1] === "start" && args.includes("8642")) {
          secondaryStarted = true;
        }
        return { status: 0 } as never;
      });

    expect(
      withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("hermes-box", { quiet: true })),
    ).toEqual({
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: true,
    });

    const startedNonPrimary = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return (
        args[0] === "forward" &&
        args[1] === "start" &&
        args.includes("--background") &&
        args.includes("8642") &&
        args.includes("hermes-box")
      );
    });
    expect(startedNonPrimary).toBe(true);

    const startedPrimary = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return (
        args[0] === "forward" &&
        args[1] === "start" &&
        args.includes("--background") &&
        args.includes("18789") &&
        args.includes("hermes-box")
      );
    });
    expect(startedPrimary).toBe(false);
  });

  it("leaves a non-primary forward owned by another sandbox alone instead of taking it over", () => {
    const openshellRuntime = requireDist("../dist/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireDist("../dist/lib/agent/runtime.js");
    const registry = requireDist("../dist/lib/state/registry.js");
    const forwardHealth = requireDist("../dist/lib/actions/sandbox/forward-health.js");
    const childProcess = requireDist("node:child_process");
    const occupiedForwardList = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running
sibling-box  127.0.0.1  8642  99999  running`;

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      forward_ports: [18789, 8642],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation(
      (port: unknown) => Number(port) === 18789,
    );
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: occupiedForwardList,
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", { quiet: true }),
    );
    expect(result.checked).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.forwardRecovered).toBe(false);

    const touchedSecondary = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return args[0] === "forward" && args.includes("8642");
    });
    expect(touchedSecondary).toBe(false);
  });

  it("ignores invalid forward_ports entries and never invokes openshell forward start for them", () => {
    const openshellRuntime = requireDist("../dist/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireDist("../dist/lib/agent/runtime.js");
    const registry = requireDist("../dist/lib/state/registry.js");
    const forwardHealth = requireDist("../dist/lib/actions/sandbox/forward-health.js");
    const childProcess = requireDist("node:child_process");
    const primaryOnlyForward = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running`;

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      // Mixed invalid entries the helper must skip: zero, negative, fractional,
      // > 65535, non-numeric, and the primary entry.
      forward_ports: [18789, 0, -1, 1.5, 70000, "8642" as unknown as number],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: primaryOnlyForward,
    });
    const runOpenshell = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0 } as never);

    withFakeOpenshellBinary(() => checkAndRecoverSandboxProcesses("hermes-box", { quiet: true }));

    const issuedForwardStart = runOpenshell.mock.calls.some(([rawArgs]) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return args[0] === "forward" && args[1] === "start";
    });
    expect(issuedForwardStart).toBe(false);
  });

  it("reports forwardRecovered=false when one declared secondary recovers and another fails", () => {
    const openshellRuntime = requireDist("../dist/lib/adapters/openshell/runtime.js");
    const agentRuntime = requireDist("../dist/lib/agent/runtime.js");
    const registry = requireDist("../dist/lib/state/registry.js");
    const forwardHealth = requireDist("../dist/lib/actions/sandbox/forward-health.js");
    const childProcess = requireDist("node:child_process");
    const partialForward = `SANDBOX  BIND  PORT  PID  STATUS
hermes-box  127.0.0.1  18789  12345  running
hermes-box  127.0.0.1  8642  12346  running`;

    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    } as never);
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "hermes",
      forwardPort: 18789,
      forward_ports: [18789, 8642, 9100],
    });
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "hermes-box",
      agent: "hermes",
      dashboardPort: 18789,
    });
    let port9100Started = false;
    vi.spyOn(forwardHealth, "isLocalForwardReachable").mockImplementation((port: unknown) => {
      if (Number(port) === 18789) return true;
      if (Number(port) === 8642) return true;
      if (Number(port) === 9100) return port9100Started;
      return false;
    });
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: partialForward,
    });
    vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((rawArgs: unknown) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      if (args[0] === "forward" && args[1] === "start" && args.includes("9100")) {
        // Forward start succeeds at the OpenShell level but the post-start
        // probe stays unhealthy — simulates a port that openshell launches
        // and that immediately drops on the sandbox side.
        return { status: 0 } as never;
      }
      return { status: 0 } as never;
    });

    const result = withFakeOpenshellBinary(() =>
      checkAndRecoverSandboxProcesses("hermes-box", { quiet: true }),
    );
    void port9100Started;
    expect(result.checked).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.forwardRecovered).toBe(false);
  });
});
