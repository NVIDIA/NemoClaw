// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSandbox } from "../../../src/lib/state/registry.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import {
  cleanupOwnedSandboxAfterOnboard,
  cleanupRegisteredSandbox,
  prepareOwnedSandboxForOnboard,
} from "../fixtures/owned-sandbox-cleanup.ts";

const state = vi.hoisted(() => ({
  registered: false,
  gatewayPort: undefined as number | undefined,
}));
vi.mock("../../../src/lib/state/registry.ts", () => ({
  getSandbox: vi.fn(() =>
    state.registered ? { name: "e2e-mcp-bridge", gatewayPort: state.gatewayPort } : null,
  ),
}));

function fixture() {
  const calls: string[] = [];
  const host = {
    command: vi.fn(
      async (
        _command: string,
        _argv: string[],
        _options: ShellProbeRunOptions,
      ): Promise<ShellProbeResult> => {
        throw new Error("cleanup must not start a gateway");
      },
    ),
    cleanupSandbox: vi.fn(async (_name: string, options: ShellProbeRunOptions = {}) => {
      calls.push(`cli:${options.artifactName}`);
    }),
  };
  const sandbox = new SandboxClient({ run: vi.fn() });
  const response = (patch: Partial<ShellProbeResult> = {}): ShellProbeResult => ({
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
    ...patch,
  });
  const presentGateway = {
    stdout: JSON.stringify({ gateway: "nemoclaw" }),
  };
  const gateway = {
    name: "nemoclaw",
    response: {
      exitCode: 1,
      stderr: "No gateway configured.\n│ Register a gateway with: openshell gateway add <endpoint>",
    } as Partial<ShellProbeResult>,
  };
  const openshell = vi
    .spyOn(sandbox, "openshell")
    .mockImplementation(async (args = [], options) => {
      calls.push(args.slice(0, 2).join(" "));
      expect(options?.env?.OPENSHELL_GATEWAY).toBe(gateway.name);
      const results: Record<string, ShellProbeResult> = {
        gateway: response(gateway.response),
        sandbox: response(),
      };
      expect(results).toHaveProperty(args[0]);
      return results[args[0]]!;
    });
  const cleanup = new CleanupRegistry();
  const prepare = (orphanGatewayName?: string) =>
    prepareOwnedSandboxForOnboard(host, sandbox, cleanup, "e2e-mcp-bridge", orphanGatewayName);
  return { calls, host, sandbox, openshell, gateway, presentGateway, cleanup, prepare, response };
}

describe("owned-sandbox cleanup", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("OPENSHELL_GATEWAY", "nemoclaw");
    state.registered = false;
    state.gatewayPort = undefined;
  });

  it.each([false, true])(
    "preserves Pi cleanup ordering with a registered sandbox: %s",
    async (registered) => {
      state.registered = registered;
      const events: string[] = [];
      const cleanup = new CleanupRegistry();
      const host = {
        cleanupGatewayRegistration: vi.fn(async () => {
          events.push("registration");
        }),
        cleanupSandbox: vi.fn(async (_name: string, _options: ShellProbeRunOptions) => {
          events.push("CLI destroy");
        }),
      };
      const env = { HOME: "/owned-job-home", OPENSHELL_GATEWAY: "nemoclaw" };
      cleanup.trackDisposable("guard", () => {
        events.push("guard");
      });
      cleanup.trackGateway(host, "nemoclaw", { env });
      cleanup.trackDisposable("OpenShell delete", () => {
        events.push("OpenShell delete");
      });
      cleanup.trackDisposable("CLI destroy", () =>
        cleanupRegisteredSandbox("e2e-pi-qual", () =>
          host.cleanupSandbox("e2e-pi-qual", { env, timeoutMs: 300_000 }),
        ),
      );
      expect((await cleanup.runAll()).failures).toEqual([]);
      expect(events).toEqual(
        registered
          ? ["CLI destroy", "OpenShell delete", "registration", "guard"]
          : ["OpenShell delete", "registration", "guard"],
      );
      expect(host.cleanupSandbox.mock.calls).toEqual(
        registered ? [["e2e-pi-qual", { env, timeoutMs: 300_000 }]] : [],
      );
      expect(getSandbox).toHaveBeenCalledWith("e2e-pi-qual");
    },
  );

  it("retains a registry failure while later Pi cleanup callbacks still run", async () => {
    const cleanup = new CleanupRegistry();
    const later = vi.fn();
    const destroy = vi.fn(async () => {});
    vi.mocked(getSandbox).mockImplementationOnce(() => {
      throw new Error("invalid registry");
    });
    cleanup.trackDisposable("remaining cleanup", later);
    cleanup.trackDisposable("CLI destroy", () => cleanupRegisteredSandbox("e2e-pi-qual", destroy));
    expect((await cleanup.runAll()).failures).toEqual([
      { name: "CLI destroy", message: "invalid registry" },
    ]);
    expect(destroy).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledOnce();
  });

  function finalCleanupFixture(environment: NodeJS.ProcessEnv = {}) {
    const f = fixture();
    const run = vi.fn().mockResolvedValue(f.response());
    const runtime = new RuntimeProviderPrerequisite(
      new HostCliClient({ run }),
      undefined,
      environment,
    );
    const options = { env: { OPENSHELL_GATEWAY: "nemoclaw" }, timeoutMs: 60_000 };
    const finish = () =>
      cleanupOwnedSandboxAfterOnboard(f.sandbox, runtime, "e2e-mcp-bridge", options);
    return { ...f, run, runtime, options, finish };
  }

  it.each([
    { environment: {}, command: "docker", prefix: [] },
    {
      environment: {
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
      },
      command: "podman",
      prefix: ["--url", "unix:///run/user/1000/podman/podman.sock"],
    },
  ])(
    "accepts released resources only after empty $command inventory",
    async ({ environment, command, prefix }) => {
      const f = finalCleanupFixture(environment);
      await f.finish();
      expect(f.openshell.mock.calls.map(([args]) => args)).toEqual([
        ["gateway", "info", "-g", "nemoclaw", "-o", "json"],
      ]);
      const expectedOptions = expect.objectContaining({
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw" }),
        captureLimitBytes: 4096,
        timeoutMs: 30_000,
      });
      expect(f.run.mock.calls).toEqual([
        [
          expect.objectContaining({
            command,
            args: [
              ...prefix,
              "container",
              "ps",
              "--all",
              "--no-trunc",
              "--filter",
              "label=openshell.ai/sandbox-name=e2e-mcp-bridge",
              "--format",
              "{{.ID}}",
            ],
          }),
          expectedOptions,
        ],
        [
          expect.objectContaining({
            command,
            args: [
              ...prefix,
              "volume",
              "ls",
              "--filter",
              "name=nemoclaw-openclaw-state-v1-e2e-mcp-bridge",
              "--format",
              "{{.Name}}",
            ],
          }),
          expectedOptions,
        ],
        [
          expect.objectContaining({
            command,
            args: [
              ...prefix,
              "volume",
              "ls",
              "--filter",
              "name=nemoclaw-hermes-state-v1-e2e-mcp-bridge",
              "--format",
              "{{.Name}}",
            ],
          }),
          expectedOptions,
        ],
      ]);
      expect(f.host.command).not.toHaveBeenCalled();
    },
  );

  it("keeps raw deletion for an orphan when the selected gateway exists", async () => {
    const f = finalCleanupFixture();
    f.gateway.response = f.presentGateway;
    await f.finish();
    expect(f.calls).toEqual(["gateway info", "sandbox delete"]);
    expect(f.openshell).toHaveBeenLastCalledWith(["sandbox", "delete", "e2e-mcp-bridge"], {
      ...f.options,
      artifactName: "cleanup-openshell-sandbox-e2e-mcp-bridge",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("preserves raw deletion failure when the gateway exists", async () => {
    const f = finalCleanupFixture();
    f.gateway.response = f.presentGateway;
    vi.spyOn(f.sandbox, "cleanupSandbox").mockRejectedValue(new Error("delete refused"));
    await expect(f.finish()).rejects.toThrow("delete refused");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("refuses absent-gateway cleanup for a retained registration", async () => {
    const f = finalCleanupFixture();
    state.registered = true;
    await expect(f.finish()).rejects.toThrow("registered sandbox");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["gateway info"]);
  });

  it.each([
    { stdout: "a".repeat(64) + "\n" },
    { stdout: "malformed inventory" },
    { stdout: "\n" },
    { exitCode: 1 },
    { signal: "SIGTERM" as const },
    { timedOut: true },
    { stderr: "runtime unavailable" },
  ])("preserves uncertain runtime cleanup failure: %j", async (failure) => {
    const f = finalCleanupFixture();
    f.run.mockResolvedValue(f.response(failure));
    const later = vi.fn();
    f.cleanup.trackDisposable("later cleanup", later);
    f.cleanup.trackDisposable("raw cleanup", f.finish);
    expect((await f.cleanup.runAll()).failures).toEqual([
      {
        name: "raw cleanup",
        message:
          "Cannot verify runtime absence for sandbox 'e2e-mcp-bridge' after its gateway was removed.",
      },
    ]);
    expect(later).toHaveBeenCalledOnce();
    expect(f.calls).toEqual(["gateway info"]);
  });

  it.each([
    { openclaw: { stdout: "nemoclaw-openclaw-state-v1-e2e-mcp-bridge\n" }, hermes: {} },
    { openclaw: {}, hermes: { stdout: "nemoclaw-hermes-state-v1-e2e-mcp-bridge\n" } },
    { openclaw: { exitCode: 1 }, hermes: {} },
    { openclaw: {}, hermes: { signal: "SIGTERM" as const } },
    { openclaw: { timedOut: true }, hermes: {} },
    { openclaw: {}, hermes: { stderr: "volume inventory denied" } },
  ])(
    "refuses remaining or uncertain state volumes with no containers: %j",
    async ({ openclaw, hermes }) => {
      const f = finalCleanupFixture();
      f.run
        .mockResolvedValueOnce(f.response())
        .mockResolvedValueOnce(f.response(openclaw))
        .mockResolvedValueOnce(f.response(hermes));
      await expect(f.finish()).rejects.toThrow("Cannot verify runtime absence");
      expect(f.calls).toEqual(["gateway info"]);
      expect(f.run).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { exitCode: 1, stderr: "permission denied" },
    { stdout: JSON.stringify({ gateway: "foreign" }) },
    { exitCode: 1, signal: "SIGTERM" as const, stderr: "No gateway configured." },
  ])("does not interpret uncertain gateway results as absence: %j", async (failure) => {
    const f = finalCleanupFixture();
    f.gateway.response = failure;
    await expect(f.finish()).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["gateway info"]);
  });

  it("rejects a registration acquired during the runtime inventory", async () => {
    const f = finalCleanupFixture();
    f.run.mockImplementation(async () => {
      state.registered = true;
      return f.response();
    });
    await expect(f.finish()).rejects.toThrow("Cannot verify runtime absence");
    expect(f.calls).toEqual(["gateway info"]);
  });

  it("does not start a gateway or run CLI recovery when fresh resources are absent", async () => {
    const f = fixture();
    await f.prepare();
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual(["gateway info", "gateway info"]);
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
    expect(f.host.command).not.toHaveBeenCalled();
  });

  it("deletes orphaned OpenShell resources even without a NemoClaw registry entry", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    await f.prepare();
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual(["gateway info", "sandbox delete", "gateway info", "sandbox delete"]);
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
  });

  it("recovers only a registered missing gateway with the selected provider context", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
    vi.stubEnv("OPENSHELL_PODMAN_SOCKET", "/run/user/1000/podman/podman.sock");
    const f = fixture();
    state.registered = true;
    f.host.command.mockImplementation(async (command, argv, options) => {
      expect(command).toBe(process.execPath);
      expect(argv[1]).toContain("startGatewayForRecovery");
      expect(options.env).toMatchObject({
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
      });
      f.calls.push("recover gateway");
      f.gateway.response = f.presentGateway;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        signal: null,
        timedOut: false,
        command: [],
        artifacts: { stdout: "", stderr: "", result: "" },
      };
    });
    try {
      await f.prepare();
      expect(f.calls).toEqual([
        "gateway info",
        "recover gateway",
        "gateway info",
        "sandbox delete",
        "cli:precleanup-destroy-sandbox",
      ]);
      expect((await f.cleanup.runAll()).failures).toEqual([]);
      expect(f.host.command).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when recovery does not restore the registered gateway", async () => {
    const f = fixture();
    state.registered = true;
    f.host.command.mockResolvedValue({ exitCode: 0 } as ShellProbeResult);
    await expect(f.prepare()).rejects.toThrow("is still absent");
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["gateway info", "gateway info"]);
  });

  it("recovers a registration acquired after preparation when its gateway disappears", async () => {
    const f = fixture();
    await f.prepare();
    state.registered = true;
    f.host.command.mockImplementation(async () => {
      f.calls.push("recover gateway");
      f.gateway.response = f.presentGateway;
      return { exitCode: 0 } as ShellProbeResult;
    });
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual([
      "gateway info",
      "gateway info",
      "recover gateway",
      "gateway info",
      "sandbox delete",
      "cli:cleanup-destroy-sandbox",
    ]);
  });

  it("uses the retained nondefault gateway for inspection, recovery, deletion and reconciliation", async () => {
    const f = fixture();
    state.registered = true;
    state.gatewayPort = 9443;
    f.gateway.name = "nemoclaw-9443";
    f.host.command.mockImplementation(async (_command, argv, options) => {
      expect(argv.at(-1)).toBe("nemoclaw-9443");
      expect(options.env?.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
      f.gateway.response = { stdout: JSON.stringify({ gateway: "nemoclaw-9443" }) };
      return { exitCode: 0 } as ShellProbeResult;
    });
    await f.prepare("nemoclaw-8888");
    expect(f.host.cleanupSandbox).toHaveBeenCalledWith(
      "e2e-mcp-bridge",
      expect.objectContaining({
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw-9443" }),
      }),
    );
    expect(f.openshell.mock.calls.map(([args]) => args)).toEqual([
      ["gateway", "info", "-g", "nemoclaw-9443", "-o", "json"],
      ["gateway", "info", "-g", "nemoclaw-9443", "-o", "json"],
      ["sandbox", "delete", "e2e-mcp-bridge"],
    ]);
    state.gatewayPort = 9554;
    f.gateway.name = "nemoclaw-9554";
    f.gateway.response = { stdout: JSON.stringify({ gateway: "nemoclaw-9554" }) };
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.host.cleanupSandbox).toHaveBeenLastCalledWith(
      "e2e-mcp-bridge",
      expect.objectContaining({
        env: expect.objectContaining({ OPENSHELL_GATEWAY: "nemoclaw-9554" }),
      }),
    );
  });

  it("rejects invalid retained gateway identity before any gateway operation", async () => {
    const f = fixture();
    state.registered = true;
    state.gatewayPort = -1;
    await expect(f.prepare()).rejects.toThrow("Invalid persisted sandbox gateway binding");
    expect(f.openshell).not.toHaveBeenCalled();
    expect(f.host.command).not.toHaveBeenCalled();
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
  });

  it("deletes administrator state before registered CLI reconciliation in both phases", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    state.registered = true;
    await f.prepare();
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual([
      "gateway info",
      "sandbox delete",
      "cli:precleanup-destroy-sandbox",
      "gateway info",
      "sandbox delete",
      "cli:cleanup-destroy-sandbox",
    ]);
  });

  it("checks registration at teardown so resources acquired after preparation are cleaned", async () => {
    const f = fixture();
    await f.prepare();
    state.registered = true;
    f.gateway.response = f.presentGateway;
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.calls).toEqual([
      "gateway info",
      "gateway info",
      "sandbox delete",
      "cli:cleanup-destroy-sandbox",
    ]);
  });

  it("does not recover a CLI entry that disappeared before teardown", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    state.registered = true;
    await f.prepare();
    state.registered = false;
    expect((await f.cleanup.runAll()).failures).toEqual([]);
    expect(f.host.cleanupSandbox).toHaveBeenCalledTimes(1);
  });

  it.each([
    { exitCode: 1, stderr: "permission denied" },
    { exitCode: null, timedOut: true, stderr: "No gateway configured." },
    { stdout: "invalid json" },
  ])("fails closed on uncertain gateway evidence %j", async (failure) => {
    const f = fixture();
    f.gateway.response = failure;
    await expect(f.prepare()).rejects.toThrow();
    const result = await f.cleanup.runAll();
    expect(result.failures).toHaveLength(1);
    expect(f.calls).toEqual(["gateway info", "gateway info"]);
    expect(f.host.cleanupSandbox).not.toHaveBeenCalled();
  });

  it("records administrator cleanup failure while still reconciling registered CLI state", async () => {
    const f = fixture();
    f.gateway.response = f.presentGateway;
    state.registered = true;
    await f.prepare();
    f.openshell.mockRejectedValueOnce(new Error("openshell cleanup failed"));
    expect((await f.cleanup.runAll()).failures).toEqual([
      {
        name: "delete owned OpenShell sandbox e2e-mcp-bridge",
        message: "openshell cleanup failed",
      },
    ]);
    expect(f.calls.at(-1)).toBe("cli:cleanup-destroy-sandbox");
  });
});

it("rejects an invalid explicit orphan gateway before cleanup mutation", async () => {
  state.registered = false;
  const f = fixture();
  await expect(f.prepare("unrelated")).rejects.toThrow("Invalid persisted sandbox gateway binding");
  expect(f.openshell).not.toHaveBeenCalled();
  expect(f.host.command).not.toHaveBeenCalled();
});
