// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as projection from "../../onboard/hermes/initial-inference-route";
import { patchHermesInferenceConfig } from "../inference-set";
import { applyHermesManagedRoute } from "../../hermes-managed-route";
import { NVIDIA_INFERENCE_PLACEHOLDER } from "../../inference-credential";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "../../inference/native-nvidia/contract";
import type { ConfigObject } from "../../security/credential-filter";
import * as registry from "../../state/registry";
import * as capture from "../../adapters/openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  refreshRestoredHermesInferenceRoute,
  restartHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestoreForCronGate,
} from "./rebuild-hermes-post-restore";

const RESTART_SUCCEEDED = {
  ok: true,
  restarted: true,
  healthPassed: true,
  forwardRecovered: false,
} as const;

const RESTART_REFUSED = {
  ok: false,
  failureLayer: "native agent command",
  detail: "native Hermes restart failed",
} as const;

const RESTART_HEALTH_TIMEOUT = {
  ok: false,
  failureLayer: "health timeout",
  detail: "gateway process restarted but health did not pass before timeout",
} as const;

describe("binding the Hermes gateway to restored state", () => {
  it("keeps native restart and health operations pinned to the selected OpenShell runtime", async () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw-19080",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const restartSandboxGateway = vi.fn(async () => RESTART_SUCCEEDED);
    const checkAndRecoverSandboxProcesses = vi.fn(async () => ({
      checked: true,
      wasRunning: true,
      recovered: false,
    }));

    const restartState = await restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway,
      runtimeSelection,
    });
    expect(restartState).toBe("restarted");
    expect(restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
      runtimeSelection,
    });

    expect(
      await verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses,
        runtimeSelection,
      }),
    ).toBe("healthy");
    expect(checkAndRecoverSandboxProcesses).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
      runtimeSelection,
    });
  });

  it("preserves a config-integrity refusal before gateway replacement (#8671)", async () => {
    const restartState = await restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: async () => RESTART_REFUSED,
    });

    expect(restartState).toBe("restart-failed");
    expect(
      await verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses: async () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
        }),
      }),
    ).toBe("unverified");
  });

  it("accepts a restarted Hermes gateway that becomes healthy just after the restart wait", async () => {
    const restartState = await restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: async () => RESTART_HEALTH_TIMEOUT,
    });

    expect(restartState).toBe("restart-health-timeout");
    expect(
      await verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses: async () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
        }),
      }),
    ).toBe("healthy");
  });

  it("does not accept a timed-out Hermes restart without a healthy replacement", async () => {
    const restartState = await restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: async () => RESTART_HEALTH_TIMEOUT,
    });

    expect(
      await verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses: async () => ({
          checked: true,
          wasRunning: false,
          recovered: false,
        }),
      }),
    ).toBe("unverified");
  });

  it("verifies the final cron-bound gateway without restarting after MCP restoration (#8472)", async () => {
    const original = { pid: 41, start_time: 902, drain_token: "restore-token" };
    const replacement = {
      pid: 77,
      start_time: 903,
      drain_token: "restore-token",
    };
    const restartSandboxGateway = vi.fn(async () => RESTART_SUCCEEDED);
    const observeHermesCronReplacement = vi.fn(() => replacement);

    expect(
      await verifyHermesGatewayAfterStateRestoreForCronGate(
        "alpha",
        "hermes",
        "restarted",
        original,
        {
          restartSandboxGateway,
          observeHermesCronReplacement,
          checkAndRecoverSandboxProcesses: async () => ({
            checked: true,
            wasRunning: true,
            recovered: false,
          }),
        },
      ),
    ).toEqual({ state: "healthy", replacementIdentity: replacement });
    expect(restartSandboxGateway).not.toHaveBeenCalled();
    expect(observeHermesCronReplacement).toHaveBeenCalledTimes(2);
  });

  it("rejects unstable final cron identity without restarting after MCP restoration (#8472)", async () => {
    const restartSandboxGateway = vi.fn(async () => RESTART_SUCCEEDED);
    const observeHermesCronReplacement = vi
      .fn()
      .mockReturnValueOnce({
        pid: 77,
        start_time: 903,
        drain_token: "restore-token",
      })
      .mockReturnValueOnce({
        pid: 88,
        start_time: 904,
        drain_token: "restore-token",
      });

    expect(
      await verifyHermesGatewayAfterStateRestoreForCronGate(
        "alpha",
        "hermes",
        "restarted",
        { pid: 41, start_time: 902, drain_token: "restore-token" },
        {
          restartSandboxGateway,
          observeHermesCronReplacement,
          checkAndRecoverSandboxProcesses: async () => ({
            checked: true,
            wasRunning: true,
            recovered: false,
          }),
        },
      ),
    ).toEqual({ state: "unverified" });
    expect(restartSandboxGateway).not.toHaveBeenCalled();
  });
});

describe("Hermes rebuild post-restore verification", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("rebinds restored Hermes state before restoring MCP", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
      }),
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes", provider: "nvidia-router" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry], {
      gatewayName: "nemoclaw",
      workspace: "default",
    });
    expect(harness.restartSandboxGatewaySpy).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
      runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
    });
    expect(harness.checkAndRecoverSandboxProcessesSpy).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
      runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
    });
  });

  it("returns a failed rebuild when managed Hermes MCP restoration is incomplete (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes", provider: "nvidia-router" },
    });
    harness.restoreMcpBridgesAfterRebuildSpy.mockRejectedValueOnce(new Error("reload failed"));

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("fails before recovery when recreated Hermes identity is missing (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sessionAgentName: null,
      sandboxEntry: { agent: "hermes", provider: "nvidia-router" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      "Recreated sandbox agent identity did not match the authoritative rebuild target",
    );

    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });

  it("rebinds and verifies ordinary Hermes after restoring its durable state", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sandboxEntry: { agent: "hermes", provider: "nvidia-router" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.restartSandboxGatewaySpy).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
    });
    expect(harness.checkAndRecoverSandboxProcessesSpy).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
    });
  });

  it("fails before recovery when recreated Hermes identity mismatches (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sessionAgentName: "langchain-deepagents-code",
      sandboxEntry: { agent: "hermes", provider: "nvidia-router" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      "Recreated sandbox agent identity did not match the authoritative rebuild target",
    );

    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });
});

describe("restored Hermes NVIDIA credential handoff", () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture(discord: boolean) {
    const runtime = { gatewayName: "selected-gateway", workspace: "default" };
    const entry: registry.SandboxEntry = {
      name: "alpha",
      agent: "hermes",
      gatewayName: runtime.gatewayName,
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      provider: "nvidia-prod",
      lifecycleGeneration: "replacement-generation",
      lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("replacement-id")!,
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "nvidia-provider-id",
      },
    };
    const config: ConfigObject = {
      display: { show_reasoning: false },
      mcp_servers: { example: { command: "example-mcp" } },
      ...(discord ? { discord: { require_mention: true, allowed_users: ["123"] } } : {}),
    };
    applyHermesManagedRoute(config, {
      upstreamProvider: entry.provider!,
      model: entry.model!,
      baseUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
      inferenceApi: "openai-completions",
      contextWindow: 131072,
    });
    Object.assign(config.model, { temperature: 0.25 });
    const target = {
      agentName: "hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configDir: "/sandbox/.hermes",
      configFile: "config.yaml",
      format: "yaml" as const,
      sensitiveFiles: [],
    };
    const handle = "openshell:resolve:env:v8_NVIDIA_INFERENCE_API_KEY";
    const io = {
      withSandboxMutationLock: async <T>(_name: string, action: () => Promise<T>) => action(),
      readNvidiaCredentialHandle: vi.fn(async () => handle),
      readCredentialHandle: vi.fn(async () => {
        throw new Error("NVIDIA restore must not read local-provider credentials");
      }),
      resolveAgentConfig: vi.fn(() => target),
      readSandboxConfig: vi.fn(() => config),
      writeSandboxConfig: vi.fn(),
      restartGateway: vi.fn(async () => ({ ok: true })),
    } satisfies Omit<
      projection.InitialHermesInferenceRouteDeps,
      "getSandbox" | "patchHermesInferenceConfig"
    >;
    const createRoute = projection.createInitialHermesInferenceRoute;
    // Inject I/O through the existing seam; execute the real factory with the caller's options.
    vi.spyOn(projection, "createInitialHermesInferenceRoute").mockImplementation(
      (overrides, options) =>
        createRoute({ ...io, patchHermesInferenceConfig, ...overrides }, options),
    );
    vi.spyOn(capture, "captureSanitizedResolvedOpenshell").mockReturnValue({
      status: 0,
      output: "Id: replacement-id",
      stdout: "Id: replacement-id",
      stderr: "",
    });
    const run = () => refreshRestoredHermesInferenceRoute("alpha", runtime, () => entry, {});
    return { config, entry, handle, io, run, runtime, target };
  }

  it.each([false, true])(
    "writes fresh NVIDIA references with Discord enrolled: %s (#14020)",
    async (discord) => {
      const f = fixture(discord);
      expect(f.config.model.api_key).toBe(NVIDIA_INFERENCE_PLACEHOLDER);
      expect(f.config.providers["nvidia-prod"]!.api_key).toBe(NVIDIA_INFERENCE_PLACEHOLDER);
      expect(f.config.custom_providers[0]!.api_key).toBe(NVIDIA_INFERENCE_PLACEHOLDER);
      const expected = structuredClone(f.config);

      await f.run();

      expected.model.api_key = f.handle;
      expected.providers["nvidia-prod"]!.api_key = f.handle;
      expected.custom_providers[0]!.api_key = f.handle;
      expect(f.config).toEqual(expected);
      expect(f.io.readNvidiaCredentialHandle).toHaveBeenCalledExactlyOnceWith(
        "alpha",
        f.runtime.gatewayName,
        f.entry.nativeNvidiaProviderAttachment,
      );
      expect(f.io.readCredentialHandle).not.toHaveBeenCalled();
      expect(f.io.writeSandboxConfig).toHaveBeenCalledExactlyOnceWith("alpha", f.target, expected, {
        restoreNativeLocalCredential: true,
      });
      expect(f.io.writeSandboxConfig.mock.calls[0]![2]).toBe(f.config);
      expect(f.io.restartGateway).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid restored NVIDIA route before writing (#14020)", async () => {
    const f = fixture(true);
    f.config.model.base_url = "https://other.example/v1";
    const before = structuredClone(f.config);

    await expect(f.run()).rejects.toThrow();

    expect(f.io.readSandboxConfig).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      f.target,
      f.runtime.gatewayName,
    );
    expect(f.config).toEqual(before);
    expect(f.io.writeSandboxConfig).not.toHaveBeenCalled();
    expect(f.io.restartGateway).not.toHaveBeenCalled();
  });
});

describe("restored Hermes route identity", () => {
  const runtime = {
    gatewayName: "selected-gateway",
    workspace: "selected-workspace",
    localTlsDir: "/selected/tls",
  };
  const commandEnvironment = {
    OPENSHELL_GATEWAY: runtime.gatewayName,
    OPENSHELL_WORKSPACE: runtime.workspace,
    OPENSHELL_LOCAL_TLS_DIR: runtime.localTlsDir,
    ABSENT: undefined,
  };
  function fixture() {
    const entry = {
      name: "alpha",
      agent: "hermes",
      gatewayName: runtime.gatewayName,
      model: "selected-model",
      provider: "compatible-endpoint",
      lifecycleGeneration: "replacement-generation",
      lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId("replacement-id"),
    } as registry.SandboxEntry;
    vi.spyOn(registry, "getSandbox").mockImplementation(() => entry);
    const observe = vi.spyOn(capture, "captureSanitizedResolvedOpenshell").mockReturnValue({
      status: 0,
      output: "Id: replacement-id",
      stdout: "Id: replacement-id",
      stderr: "",
    });
    const write = vi.fn();
    const project = vi.fn<projection.InitializeHermesInferenceRoute>(
      async (_name, _model, _provider, _gateway, revalidate) => {
        revalidate?.("write restored config");
        write();
      },
    );
    const factory = vi
      .spyOn(projection, "createInitialHermesInferenceRoute")
      .mockReturnValue(project);
    return { entry, observe, write, project, factory };
  }

  afterEach(() => vi.restoreAllMocks());

  it("pins the replacement live identity and selected runtime before deferred projection", async () => {
    const f = fixture();
    await refreshRestoredHermesInferenceRoute(
      "alpha",
      runtime,
      registry.getSandbox,
      commandEnvironment,
    );
    expect(f.factory).toHaveBeenCalledWith(
      expect.objectContaining({ getSandbox: expect.any(Function) }),
      { activation: "deferred", workload: "registered", projection: "credential" },
    );
    expect(f.project).toHaveBeenCalledWith(
      "alpha",
      "selected-model",
      "compatible-endpoint",
      runtime.gatewayName,
      expect.any(Function),
    );
    expect(f.observe).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", runtime.gatewayName, "alpha"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: runtime.gatewayName,
          OPENSHELL_WORKSPACE: runtime.workspace,
          OPENSHELL_LOCAL_TLS_DIR: runtime.localTlsDir,
        }),
        replaceEnv: true,
        timeout: 30000,
      }),
    );
    expect(f.observe.mock.calls[0][1]?.env).not.toHaveProperty("ABSENT");
    expect(f.write).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "same-name replacement",
      arrange: (f: ReturnType<typeof fixture>) =>
        f.observe.mockReturnValue({
          status: 0,
          output: "Id: foreign-id",
          stdout: "Id: foreign-id",
        }),
    },
    {
      name: "unobservable target",
      arrange: (f: ReturnType<typeof fixture>) =>
        f.observe.mockReturnValue({
          status: 1,
          output: "unavailable",
          stdout: "",
        }),
    },
    {
      name: "registered generation drift",
      arrange: (f: ReturnType<typeof fixture>) =>
        f.project.mockImplementation(async (_n, _m, _p, _g, revalidate) => {
          f.entry.lifecycleGeneration = "foreign-generation";
          revalidate?.("write restored config");
          f.write();
        }),
    },
  ])("refuses $name without a write", async ({ arrange }) => {
    const f = fixture();
    arrange(f);
    await expect(
      refreshRestoredHermesInferenceRoute(
        "alpha",
        runtime,
        registry.getSandbox,
        commandEnvironment,
      ),
    ).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });
});
