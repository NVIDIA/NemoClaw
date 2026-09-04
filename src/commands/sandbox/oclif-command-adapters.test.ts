// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as portableAgentLifecycle from "../../lib/onboard/experimental/portable-agent-lifecycle";
import * as receiptAuthority from "../../lib/onboard/experimental/hermes-portable-receipt";
import { isMcpLifecycleLockHeld } from "../../lib/state/mcp-lifecycle-lock-acquisition";

const mocks = vi.hoisted(() => {
  class SandboxConfigError extends Error {
    lines: readonly string[];
    exitCode: number;

    constructor(lines: string | readonly string[], exitCode = 1) {
      const normalized = Array.isArray(lines) ? lines : [lines];
      super(normalized.join("\n"));
      this.lines = normalized;
      this.exitCode = exitCode;
    }
  }

  return {
    configGet: vi.fn(),
    configRotateToken: vi.fn().mockResolvedValue(undefined),
    configSet: vi.fn().mockResolvedValue(undefined),
    connectSandbox: vi.fn().mockResolvedValue(undefined),
    destroySandbox: vi.fn().mockResolvedValue(undefined),
    listSandboxChannels: vi.fn(),
    listSandboxPolicies: vi.fn(),
    rebuildSandbox: vi.fn().mockResolvedValue(undefined),
    restartSandboxGateway: vi.fn().mockReturnValue({ ok: true }),
    recoverSandboxWithHermesCronRestore: vi.fn().mockResolvedValue(undefined),
    runSandboxDoctor: vi.fn().mockResolvedValue(undefined),
    showSandboxLogs: vi.fn(),
    showSandboxStatus: vi.fn().mockResolvedValue(undefined),
    addSandboxHostAlias: vi.fn(),
    listSandboxHostAliases: vi.fn(),
    removeSandboxHostAlias: vi.fn(),
    SandboxConfigError,
  };
});

vi.mock("../../lib/actions/sandbox/connect", () => ({
  connectSandbox: mocks.connectSandbox,
}));

vi.mock("../../lib/actions/sandbox/destroy", () => ({
  destroySandbox: mocks.destroySandbox,
}));

vi.mock("../../lib/actions/sandbox/runtime/hermes-cron-restore-recovery", () => ({
  recoverSandboxWithHermesCronRestore: mocks.recoverSandboxWithHermesCronRestore,
}));

vi.mock("../../lib/actions/sandbox/rebuild", () => ({
  rebuildSandbox: mocks.rebuildSandbox,
}));

vi.mock("../../lib/actions/sandbox/process-recovery", () => ({
  restartSandboxGateway: mocks.restartSandboxGateway,
}));

vi.mock("../../lib/actions/sandbox/status", () => ({
  showSandboxStatus: mocks.showSandboxStatus,
}));

vi.mock("../../lib/actions/sandbox/logs", () => ({
  showSandboxLogs: mocks.showSandboxLogs,
}));

vi.mock("../../lib/actions/sandbox/policy-channel", () => ({
  listSandboxChannels: mocks.listSandboxChannels,
  listSandboxPolicies: mocks.listSandboxPolicies,
}));

vi.mock("../../lib/actions/sandbox/host-aliases", () => ({
  addSandboxHostAlias: mocks.addSandboxHostAlias,
  listSandboxHostAliases: mocks.listSandboxHostAliases,
  removeSandboxHostAlias: mocks.removeSandboxHostAlias,
}));

vi.mock("../../lib/sandbox/config", () => ({
  configGet: mocks.configGet,
  configRotateToken: mocks.configRotateToken,
  configSet: mocks.configSet,
  SandboxConfigError: mocks.SandboxConfigError,
}));

vi.mock("../../lib/actions/sandbox/doctor", () => ({
  runSandboxDoctor: mocks.runSandboxDoctor,
}));

import SandboxChannelsListCommand from "./channels/list";
import SandboxConfigGetCommand from "./config/get";
import SandboxConfigRotateTokenCommand from "./config/rotate-token";
import SandboxConfigSetCommand from "./config/set";
import ConnectCliCommand from "./connect";
import DashboardUrlCliCommand, {
  setDashboardUrlRuntimeBridgeFactoryForTest,
} from "./dashboard-url";
import DestroyCliCommand from "./destroy";
import SandboxDoctorCliCommand from "./doctor";
import GatewayRestartCliCommand from "./gateway/restart";
import HostsAddCommand from "./hosts/add";
import HostsListCommand from "./hosts/list";
import HostsRemoveCommand from "./hosts/remove";
import SandboxLogsCommand from "./logs";
import SandboxPolicyListCommand from "./policy/list";
import RebuildCliCommand from "./rebuild";
import RecoverCliCommand from "./recover";
import SandboxStatusCommand from "./status";

const rootDir = process.cwd();

describe("sandbox oclif command adapters", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-command-adapters-"));
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it("maps connect and lifecycle flags to typed action options", async () => {
    const originalCleanupGatewayEnv = process.env.NEMOCLAW_CLEANUP_GATEWAY;
    delete process.env.NEMOCLAW_CLEANUP_GATEWAY;
    try {
      await ConnectCliCommand.run(["alpha", "--probe-only"], rootDir);
      await RecoverCliCommand.run(["alpha"], rootDir);
      await DestroyCliCommand.run(["alpha", "--yes"], rootDir);
      await RebuildCliCommand.run(
        [
          "alpha",
          "--force",
          "--verbose",
          "--tool-disclosure",
          "direct",
          "--dcode-auto-approval",
          "thread-opt-in",
        ],
        rootDir,
      );
      await RebuildCliCommand.run(["dcode", "--yes", "--no-observability"], rootDir);
      await GatewayRestartCliCommand.run(["alpha", "--quiet"], rootDir);

      expect(mocks.connectSandbox).toHaveBeenCalledWith("alpha", { probeOnly: true });
      expect(mocks.recoverSandboxWithHermesCronRestore).toHaveBeenCalledWith("alpha");
      expect(mocks.destroySandbox).toHaveBeenCalledWith("alpha", { force: false, yes: true });
      expect(mocks.rebuildSandbox).toHaveBeenCalledWith("alpha", {
        dcodeAutoApprovalMode: "thread-opt-in",
        force: true,
        toolDisclosure: "direct",
        verbose: true,
        yes: false,
      });
      expect(mocks.rebuildSandbox).toHaveBeenCalledWith("dcode", {
        dcodeAutoApprovalMode: undefined,
        force: false,
        observabilityEnabled: false,
        toolDisclosure: undefined,
        verbose: false,
        yes: true,
      });
      expect(mocks.restartSandboxGateway).toHaveBeenCalledWith("alpha", { quiet: true });
    } finally {
      if (originalCleanupGatewayEnv === undefined) {
        delete process.env.NEMOCLAW_CLEANUP_GATEWAY;
      } else {
        process.env.NEMOCLAW_CLEANUP_GATEWAY = originalCleanupGatewayEnv;
      }
    }
  });

  it("does not hold the command lifecycle lock during an interactive connect (#9737)", async () => {
    mocks.connectSandbox.mockImplementationOnce(async () => {
      expect(isMcpLifecycleLockHeld("alpha")).toBe(false);
    });

    await ConnectCliCommand.run(["alpha"], rootDir);
    expect(mocks.connectSandbox).toHaveBeenCalledOnce();
  });

  it("holds the command lifecycle lock during connect probe recovery (#9737)", async () => {
    mocks.connectSandbox.mockImplementationOnce(async () => {
      expect(isMcpLifecycleLockHeld("alpha")).toBe(true);
    });

    await ConnectCliCommand.run(["alpha", "--probe-only"], rootDir);
    expect(mocks.connectSandbox).toHaveBeenCalledOnce();
  });

  it("rejects the removed connect permission bypass before dispatch", async () => {
    const previousExitCode = process.exitCode;
    const lines: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((line = "") => {
      lines.push(String(line));
    });
    process.exitCode = undefined;

    try {
      await ConnectCliCommand.run(["alpha", "--dangerously-skip-permissions"], rootDir);

      expect(lines.join("\n")).toContain("--dangerously-skip-permissions was removed.");
      expect(process.exitCode).toBe(1);
      expect(mocks.connectSandbox).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it("threads --cleanup-gateway / --no-cleanup-gateway through destroy (#2166)", async () => {
    const originalCleanupGatewayEnv = process.env.NEMOCLAW_CLEANUP_GATEWAY;
    delete process.env.NEMOCLAW_CLEANUP_GATEWAY;
    try {
      await DestroyCliCommand.run(["alpha", "--yes", "--cleanup-gateway"], rootDir);
      expect(mocks.destroySandbox).toHaveBeenLastCalledWith("alpha", {
        force: false,
        yes: true,
        cleanupGateway: true,
      });

      await DestroyCliCommand.run(["alpha", "--yes", "--no-cleanup-gateway"], rootDir);
      expect(mocks.destroySandbox).toHaveBeenLastCalledWith("alpha", {
        force: false,
        yes: true,
        cleanupGateway: false,
      });
    } finally {
      if (originalCleanupGatewayEnv === undefined) {
        delete process.env.NEMOCLAW_CLEANUP_GATEWAY;
      } else {
        process.env.NEMOCLAW_CLEANUP_GATEWAY = originalCleanupGatewayEnv;
      }
    }
  });

  it("maps inspection commands to their action helpers", async () => {
    await SandboxStatusCommand.run(["alpha"], rootDir);
    await SandboxPolicyListCommand.run(["alpha"], rootDir);
    await SandboxChannelsListCommand.run(["alpha"], rootDir);
    await SandboxConfigGetCommand.run(["alpha", "--key", "model", "--format", "yaml"], rootDir);
    await SandboxLogsCommand.run(["alpha", "--tail", "25", "--since", "5m"], rootDir);

    expect(mocks.showSandboxStatus).toHaveBeenCalledWith("alpha");
    expect(mocks.listSandboxPolicies).toHaveBeenCalledWith("alpha");
    expect(mocks.listSandboxChannels).toHaveBeenCalledWith("alpha");
    expect(mocks.configGet).toHaveBeenCalledWith("alpha", { key: "model", format: "yaml" });
    expect(mocks.showSandboxLogs).toHaveBeenCalledWith("alpha", {
      follow: false,
      lines: "25",
      since: "5m",
    });
  });

  it("rejects real schema-5 logs and dashboard-token routes before their actions (#9203)", async () => {
    const fetchToken = vi.fn(() => "test-token");
    const getSandbox = vi.fn(() => ({ agent: "openclaw", dashboardPort: 18789 }));
    const getAccessUrl = vi.fn(() => "http://127.0.0.1:18789");
    setDashboardUrlRuntimeBridgeFactoryForTest(() => ({
      fetchGatewayAuthTokenFromSandbox: fetchToken,
      getSandbox,
      getAccessUrl,
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await DashboardUrlCliCommand.run(["alpha", "--quiet"], rootDir);
    expect(fetchToken).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    const authority = {
      kind: "hermes",
      snapshot: { receipt: { phase: "active" } } as never,
    } as const;
    vi.spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthority").mockReturnValue(authority);
    vi.spyOn(
      receiptAuthority,
      "inspectPortableAgentReceiptAuthorityForClassification",
    ).mockReturnValue(authority);

    await expect(SandboxLogsCommand.run(["alpha"], rootDir)).rejects.toThrow(
      "not supported for an experimental Hermes portable sandbox",
    );
    await expect(DashboardUrlCliCommand.run(["--quiet", "alpha"], rootDir)).rejects.toThrow(
      "not supported for an experimental Hermes portable sandbox",
    );
    expect(mocks.showSandboxLogs).not.toHaveBeenCalled();
    expect(fetchToken).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(getAccessUrl).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it("maps ordinary config mutations and rejects schema-5 before their actions (#9203)", async ({
    onTestFinished,
  }) => {
    await SandboxConfigSetCommand.run(["alpha", "--key", "model", "--value", "next"], rootDir);
    await SandboxConfigRotateTokenCommand.run(["alpha", "--from-env", "TOKEN"], rootDir);
    expect(mocks.configSet).toHaveBeenCalledOnce();
    expect(mocks.configRotateToken).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    const guard = vi
      .spyOn(portableAgentLifecycle, "assertHermesPortableCommandUnavailable")
      .mockImplementation(() => {
        throw new Error("schema-5 rejected");
      });
    onTestFinished(() => guard.mockRestore());

    await expect(
      SandboxConfigSetCommand.run(["alpha", "--key", "model", "--value", "next"], rootDir),
    ).rejects.toThrow("schema-5 rejected");
    await expect(
      SandboxConfigRotateTokenCommand.run(["alpha", "--from-env", "TOKEN"], rootDir),
    ).rejects.toThrow("schema-5 rejected");
    expect(mocks.configSet).not.toHaveBeenCalled();
    expect(mocks.configRotateToken).not.toHaveBeenCalled();
  });

  it("keeps sandbox inspection usage metadata on native oclif commands", () => {
    const usage = (command: { usage?: string[] }) => command.usage?.join(" ") ?? "";

    expect(ConnectCliCommand.id).toBe("sandbox:connect");
    expect(usage(ConnectCliCommand)).toContain("<name> [--probe-only]");
    expect(SandboxStatusCommand.id).toBe("sandbox:status");
    expect(usage(SandboxStatusCommand)).toContain("<name> [--json]");
    expect(SandboxDoctorCliCommand.id).toBe("sandbox:doctor");
    expect(usage(SandboxDoctorCliCommand)).toContain("<name> [--json] [--fix]");
    expect(SandboxLogsCommand.id).toBe("sandbox:logs");
    expect(usage(SandboxLogsCommand)).toContain("[--follow]");
    expect(usage(SandboxLogsCommand)).toContain("[--tail <lines>|-n <lines>]");
    expect(DestroyCliCommand.id).toBe("sandbox:destroy");
    expect(usage(DestroyCliCommand)).toContain("[--yes|-y|--force]");
    expect(RecoverCliCommand.id).toBe("sandbox:recover");
    expect(RecoverCliCommand.summary).toMatch(/Repair a stopped sandbox gateway/);
    expect(RecoverCliCommand.description).toContain("A healthy gateway is not restarted");
    expect(RecoverCliCommand.description).toContain("gateway restart");
    expect(RecoverCliCommand.summary).not.toMatch(/^Restart\b/);
    expect(RebuildCliCommand.id).toBe("sandbox:rebuild");
    expect(usage(RebuildCliCommand)).toContain("[--yes|-y|--force]");
    expect(usage(RebuildCliCommand)).toContain("[--tool-disclosure <progressive|direct>]");
    expect(usage(RebuildCliCommand)).toContain("[--dcode-auto-approval <disabled|thread-opt-in>]");
    expect(usage(RebuildCliCommand)).toContain("[--observability|--no-observability]");
    expect(SandboxPolicyListCommand.id).toBe("sandbox:policy:list");
    expect(SandboxChannelsListCommand.id).toBe("sandbox:channels:list");
    expect(SandboxConfigGetCommand.id).toBe("sandbox:config:get");
    expect(usage(SandboxConfigGetCommand)).toContain("[--format json|yaml]");
    expect(GatewayRestartCliCommand.id).toBe("sandbox:gateway:restart");
    expect(usage(GatewayRestartCliCommand)).toContain("<name> [--quiet|-q]");
    expect(HostsAddCommand.id).toBe("sandbox:hosts:add");
    expect(usage(HostsAddCommand)).toContain("<name> <hostname> <ip> [--dry-run]");
    expect(HostsListCommand.id).toBe("sandbox:hosts:list");
    expect(HostsRemoveCommand.id).toBe("sandbox:hosts:remove");
  });

  it("rejects invalid diagnostic parser-owned flags before dispatch", async () => {
    await expect(
      SandboxConfigGetCommand.run(["alpha", "--format", "xml"], rootDir),
    ).rejects.toThrow(/format|json|yaml/i);
    await expect(SandboxDoctorCliCommand.run(["alpha", "--bogus"], rootDir)).rejects.toThrow(
      /bogus/i,
    );

    expect(mocks.configGet).not.toHaveBeenCalled();
    expect(mocks.runSandboxDoctor).not.toHaveBeenCalled();
  });

  it("maps config action failures to oclif exit codes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.configGet.mockImplementationOnce(() => {
        throw new mocks.SandboxConfigError(["config missing", "try again"], 5);
      });

      await expect(SandboxConfigGetCommand.run(["alpha"], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(5);
      expect(error).toHaveBeenCalledWith("config missing");
      expect(error).toHaveBeenCalledWith("try again");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("maps the doctor command to its action helper", async () => {
    await SandboxDoctorCliCommand.run(["alpha", "--json"], rootDir);

    expect(mocks.runSandboxDoctor).toHaveBeenCalledWith("alpha", ["--json"], { quietJson: true });
  });

  it("sets a nonzero JSON exit when doctor reports inference.local failure (#6192)", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    mocks.runSandboxDoctor.mockResolvedValueOnce({
      schemaVersion: 1,
      sandbox: "alpha",
      status: "fail",
      failed: 1,
      warnings: 0,
      checks: [
        {
          group: "Inference",
          label: "Inference route (gateway)",
          status: "fail",
          detail: "Inference gateway returned HTTP 503",
        },
      ],
    });

    try {
      await SandboxDoctorCliCommand.run(["alpha", "--json"], rootDir);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("redacts token-shaped values from the doctor --json report", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    mocks.runSandboxDoctor.mockResolvedValueOnce({
      schemaVersion: 1,
      sandbox: "alpha",
      status: "fail",
      failed: 1,
      warnings: 0,
      checks: [
        {
          group: "Gateway",
          label: "Gateway status",
          status: "fail",
          detail: "connect failed: Authorization: Bearer sk-abc123DEF456ghi789 (HTTP 401)",
        },
      ],
    });

    try {
      const report = (await SandboxDoctorCliCommand.run(["alpha", "--json"], rootDir)) as {
        checks: Array<{ detail: string }>;
      };
      expect(process.exitCode).toBe(1);
      expect(report.checks[0]?.detail).toBe(
        "connect failed: Authorization: Bearer <REDACTED> (HTTP 401)",
      );
      expect(JSON.stringify(report)).not.toContain("sk-abc123DEF456ghi789");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("keeps doctor --json stdout clean while diagnostics recovery prints progress", async () => {
    const report = {
      schemaVersion: 1,
      sandbox: "alpha",
      status: "ok",
      failed: 0,
      warnings: 0,
      checks: [],
    };
    mocks.runSandboxDoctor.mockImplementationOnce(async () => {
      process.stdout.write("  Starting OpenShell gateway\n");
      return report;
    });

    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      out.push(typeof chunk === "string" ? chunk : String(chunk));
      const cb = rest.find((arg) => typeof arg === "function") as undefined | (() => void);
      if (cb) cb();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      err.push(typeof chunk === "string" ? chunk : String(chunk));
      const cb = rest.find((arg) => typeof arg === "function") as undefined | (() => void);
      if (cb) cb();
      return true;
    }) as typeof process.stderr.write;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await SandboxDoctorCliCommand.run(["alpha", "--json"], rootDir);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    const stdout = out.join("");
    expect(stdout).not.toContain("Starting OpenShell gateway");
    expect(stdout).toBe("");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(report);
    expect(err.join("")).toContain("Starting OpenShell gateway");
  });
});
