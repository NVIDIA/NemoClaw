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
});
