// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OpenShellForwardAdapter,
  OpenShellForwardObservation,
} from "../adapters/openshell/forward";
import * as forwardRuntime from "../adapters/openshell/forward-runtime";
import * as openshellRuntime from "../adapters/openshell/runtime";
import type { SandboxEntry } from "../state/registry/types";
import type { OpenShellForwardPortObserver } from "./dashboard-port";
import {
  authoritativeRebuildSandboxFlowOptions,
  authoritativeRebuildRuntimePreflightOptions,
  beginAuthoritativeRebuildRuntimeSelectionScope,
  type AuthoritativeRebuildTargetDeps,
  type AuthoritativeRebuildPreflightOptions,
  preflightAuthoritativeRebuildTarget,
  rebuildProviderFlowOptions,
  resolveAuthoritativeOnboardGatewayBinding,
  resolveAuthoritativeRebuildDashboardBind,
  runtimePreflightDependencies,
} from "./authoritative-rebuild-target";
import type { InferenceRouteState } from "./inference-route";
import {
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../inference/native-nvidia/contract";
import { HOSTED_NATIVE_PROVIDERS } from "../inference/native-provider/hosted";
import {
  mintProviderRecoveryReceipt,
  type ProviderRecoveryReceiptTarget,
} from "./rebuild-route-handoff";

const target = {
  sandboxName: "alpha",
  provider: "nvidia-prod",
  model: "nvidia/nemotron",
  targetGatewayName: "nemoclaw-12345",
  controlUiPort: 18789,
};
const originalGateway = process.env.OPENSHELL_GATEWAY;

function forwardObserver(
  state: "absent" | "foreign" | "owned" | "stale" | "indeterminate" = "owned",
): OpenShellForwardPortObserver {
  return vi.fn<OpenShellForwardPortObserver>(async (ports) =>
    ports.map((port): OpenShellForwardObservation => {
      const forward = {
        gatewayEndpoint: "https://127.0.0.1:12345",
        gatewayName: "nemoclaw-12345",
        workspace: "default",
        sandboxName: "alpha",
        localHost: "127.0.0.1" as const,
        port,
      };
      return state === "indeterminate"
        ? {
            state,
            forward,
            error: {
              kind: "ownership",
              message: "NemoClaw could not prove OpenShell forward ownership.",
            },
          }
        : { state, forward };
    }),
  );
}

describe("authoritative rebuild sandbox flow options", () => {
  it("carries only the bounded live OpenShell policy handoff", () => {
    const projected = authoritativeRebuildSandboxFlowOptions({
      authoritativeResumeConfig: true,
      rebuildPolicySourcePath: "/tmp/current-policy.yaml",
    });

    expect(projected).toEqual({
      authoritativeResumeConfig: true,
      rebuildPolicySourcePath: "/tmp/current-policy.yaml",
    });
    expect(
      authoritativeRebuildSandboxFlowOptions({
        authoritativeResumeConfig: false,
      }),
    ).toEqual({ authoritativeResumeConfig: false });
  });
});

describe("authoritative rebuild runtime preflight options", () => {
  it("carries target GPU state and recorded rebuild readiness authority (#9292)", () => {
    const options = {
      authoritativeResumeConfig: true,
      sandboxName: "alpha",
      provider: "vllm-local",
      model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
      targetGatewayName: "nemoclaw-12345",
      targetGatewayPort: 12345,
      controlUiPort: null,
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=all",
      noGpu: false,
      allowDeferredN1xManagedVllm: true,
      allowLegacyDgxStationQualification: true,
    } satisfies AuthoritativeRebuildPreflightOptions;

    expect(authoritativeRebuildRuntimePreflightOptions(options)).toEqual({
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=all",
      noGpu: false,
      allowDeferredN1xManagedVllm: true,
      allowLegacyDgxStationQualification: true,
    });

    const {
      allowDeferredN1xManagedVllm: _recordedIntent,
      allowLegacyDgxStationQualification: _legacyStationAuthority,
      ...withoutRecordedIntent
    } = options;
    expect(authoritativeRebuildRuntimePreflightOptions(withoutRecordedIntent)).toEqual({
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=all",
      noGpu: false,
      allowDeferredN1xManagedVllm: false,
      allowLegacyDgxStationQualification: false,
    });
  });
});

describe("authoritative rebuild dashboard bind", () => {
  it.each([
    {
      scenario: "persisted remote preparation",
      env: {},
      context: { sandbox: { dashboardRemoteBindPrepared: true }, wsl: false },
    },
    {
      scenario: "current remote request",
      env: { NEMOCLAW_DASHBOARD_BIND: "0.0.0.0" },
      context: { sandbox: null, wsl: false },
    },
    {
      scenario: "WSL host",
      env: {},
      context: { sandbox: null, wsl: true },
    },
  ])("preserves a remote bind for $scenario", ({ env, context }) => {
    expect(resolveAuthoritativeRebuildDashboardBind(env, context)).toBe("0.0.0.0");
  });

  it("keeps an unprepared native dashboard on loopback", () => {
    expect(
      resolveAuthoritativeRebuildDashboardBind(
        {},
        { sandbox: { dashboardRemoteBindPrepared: false }, wsl: false },
      ),
    ).toBe("127.0.0.1");
  });
});

function deps(overrides: Partial<AuthoritativeRebuildTargetDeps> = {}) {
  return {
    resolveBaselinePolicy: vi.fn(() => ({})),
    bindGatewayAuthority: vi.fn(),
    runFatalRuntimePreflight: vi.fn(),
    ensureOpenshell: vi.fn(),
    assertGatewayReadiness: vi.fn(),
    getSandbox: vi.fn(() => null),
    observeSandboxPresence: vi.fn(() => "missing" as const),
    verifyNativeProviderAttachment: vi.fn(async () => undefined),
    inferenceRouteState: vi.fn((): InferenceRouteState => "matched"),
    observeForwardPorts: forwardObserver(),
    ...overrides,
  } satisfies AuthoritativeRebuildTargetDeps;
}

afterEach(() => {
  switch (originalGateway) {
    case undefined:
      delete process.env.OPENSHELL_GATEWAY;
      break;
    default:
      process.env.OPENSHELL_GATEWAY = originalGateway;
  }
});

describe("authoritative rebuild gateway binding", () => {
  const resolve = resolveAuthoritativeOnboardGatewayBinding;

  it("accepts only a paired canonical gateway name and port", () => {
    expect(
      resolve({
        authoritativeResumeConfig: true,
        targetGatewayName: " nemoclaw-8081 ",
        targetGatewayPort: 8081,
      }),
    ).toEqual({ name: "nemoclaw-8081", port: 8081 });
    expect(resolve({})).toBeNull();
  });

  it.each([
    { authoritativeResumeConfig: true, targetGatewayName: "nemoclaw-8081" },
    { authoritativeResumeConfig: true, targetGatewayPort: 8081 },
    { targetGatewayName: "nemoclaw-8081", targetGatewayPort: 8081 },
  ])("rejects partial or non-authoritative target options", (options) => {
    expect(() => resolve(options)).toThrow(/only together for an authoritative rebuild resume/);
  });

  it.each([0, 65536, 8081.5])(
    "rejects a non-canonical name or invalid target port [%s]",
    (port) => {
      expect(() =>
        resolve({
          authoritativeResumeConfig: true,
          targetGatewayName: "nemoclaw-9090",
          targetGatewayPort: 8081,
        }),
      ).toThrow(/does not match port 8081/);

      expect(() =>
        resolve({
          authoritativeResumeConfig: true,
          targetGatewayName: "nemoclaw-8081",
          targetGatewayPort: port,
        }),
      ).toThrow(/Invalid authoritative rebuild gateway port/);
    },
  );

  it("requires a complete authoritative target when the outer lifecycle owns the lock", () => {
    expect(() => resolve({ onboardLockAlreadyHeld: true })).toThrow(
      /lock handoff requires an authoritative rebuild resume/,
    );
  });
});

describe("authoritative rebuild OpenShell runtime selection", () => {
  it("replaces hostile ambient selectors for inner onboard and restores them (#10514)", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "hostile-gateway",
      OPENSHELL_GATEWAY_AUTH_TOKEN: "hostile-token",
      OPENSHELL_GATEWAY_ENDPOINT: "https://hostile.invalid",
      OPENSHELL_LOCAL_TLS_DIR: "/hostile/tls",
      OPENSHELL_WORKSPACE: "hostile-workspace",
    };
    const previous = { ...env };
    const restore = beginAuthoritativeRebuildRuntimeSelectionScope(
      {
        authoritativeResumeConfig: true,
        onboardLockAlreadyHeld: true,
        recreateSandbox: true,
        resume: true,
        targetGatewayName: "nemoclaw-8081",
        targetGatewayPort: 8081,
        runtimeSelection: {
          gatewayName: "nemoclaw-8081",
          localTlsDir: "/authority/tls",
          workspace: "default",
        },
      },
      env,
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "nemoclaw-8081",
      OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      OPENSHELL_WORKSPACE: "default",
    });
    expect(env.OPENSHELL_GATEWAY_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();

    restore();
    expect(env).toEqual(previous);
  });
});

describe("prepared provider reconfiguration handoff", () => {
  const providerTarget = {
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    model: "nvidia/model",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: "https://inference.example.test/v1",
  };
  const authorizedOptions = {
    authoritativeResumeConfig: true,
    resume: true,
    recreateSandbox: true,
    onboardLockAlreadyHeld: true,
    targetGatewayName: "nemoclaw-8081",
    targetGatewayPort: 8081,
    endpointSource: "onboard" as const,
    rebuildProviderReconfigure: providerTarget,
  };

  it("accepts an exact handoff only for a locked authoritative rebuild resume (#6114)", () => {
    expect(rebuildProviderFlowOptions(authorizedOptions, providerTarget)).toMatchObject({
      authoritativeResumeConfig: true,
      forceInferenceSetup: true,
    });
    expect(rebuildProviderFlowOptions({}, providerTarget)).toMatchObject({
      authoritativeResumeConfig: false,
      forceInferenceSetup: false,
    });
  });

  it.each([
    { scenario: "resume disabled", override: { resume: false } },
    { scenario: "sandbox recreation disabled", override: { recreateSandbox: false } },
    { scenario: "onboard lock absent", override: { onboardLockAlreadyHeld: false } },
  ])(
    "authorizes incomplete-session recovery only for the locked rebuild context [$scenario]",
    ({ override }) => {
      const recoveryOptions = { ...authorizedOptions, rebuildProviderReconfigure: undefined };
      expect(rebuildProviderFlowOptions(recoveryOptions, providerTarget)).toMatchObject({
        authoritativeResumeConfig: true,
        forceInferenceSetup: false,
      });
      const options = { ...recoveryOptions, ...override };
      expect(() => rebuildProviderFlowOptions(options, providerTarget)).toThrow(
        "requires a preflighted locked rebuild resume",
      );
    },
  );

  it("activates a matching provider-recovery receipt and binds it to the session", () => {
    const receiptTarget: ProviderRecoveryReceiptTarget = {
      sandboxName: "alpha",
      gatewayName: "nemoclaw-8081",
      provider: "compatible-endpoint",
      model: "nvidia/model",
      route: {
        provider: "compatible-endpoint",
        model: "nvidia/model",
        endpointUrl: "https://inference.example.test/v1",
        endpointSource: "onboard",
        preferredInferenceApi: "openai-completions",
        source: "registry",
      },
    };
    const receipt = mintProviderRecoveryReceipt(receiptTarget, {
      nonce: "n-alpha",
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    const flowContext = {
      ...providerTarget,
      preferredInferenceApi: "openai-completions",
      session: { sessionId: "sess-alpha" },
    };

    const activated = rebuildProviderFlowOptions(
      { ...authorizedOptions, endpointSource: "onboard", providerRecoveryReceipt: receipt },
      flowContext,
    );
    expect(activated.providerRecoveryReceipt?.sessionId).toBe("sess-alpha");

    const wrongSandbox = rebuildProviderFlowOptions(
      {
        ...authorizedOptions,
        providerRecoveryReceipt: receipt,
        rebuildProviderReconfigure: undefined,
      },
      { ...flowContext, sandboxName: "beta" },
    );
    expect(wrongSandbox.providerRecoveryReceipt).toBeNull();
  });

  it("rejects an unauthorized or mismatched handoff (#6114)", () => {
    expect(() =>
      rebuildProviderFlowOptions(
        { ...authorizedOptions, onboardLockAlreadyHeld: false },
        providerTarget,
      ),
    ).toThrow("requires a preflighted locked rebuild resume");
    expect(() =>
      rebuildProviderFlowOptions(authorizedOptions, {
        ...providerTarget,
        model: "other/model",
      }),
    ).toThrow("does not match the authoritative target");
  });
});

describe("authoritative rebuild target preflight", () => {
  it("binds process-local gateway authority before readiness and install (#7411)", async () => {
    const calls: string[] = [];
    const targetDeps = deps({
      bindGatewayAuthority: vi.fn(() => calls.push("bind")),
      runFatalRuntimePreflight: vi.fn(() => calls.push("readiness")),
      ensureOpenshell: vi.fn(() => calls.push("install")),
      assertGatewayReadiness: vi.fn(() => calls.push("post-install-readiness")),
    });

    await preflightAuthoritativeRebuildTarget(target, targetDeps);

    expect(calls).toEqual(["bind", "readiness", "install", "post-install-readiness"]);
    expect(targetDeps.bindGatewayAuthority).toHaveBeenCalledOnce();
    expect(targetDeps.assertGatewayReadiness).toHaveBeenCalledOnce();
  });

  it("rejects an unreadable replacement baseline before runtime probes (#7194)", async () => {
    const targetDeps = deps({ resolveBaselinePolicy: vi.fn(() => null) });

    await expect(preflightAuthoritativeRebuildTarget(target, targetDeps)).rejects.toThrow(
      "Could not read the baseline policy",
    );

    expect(targetDeps.runFatalRuntimePreflight).not.toHaveBeenCalled();
    expect(targetDeps.bindGatewayAuthority).not.toHaveBeenCalled();
    expect(targetDeps.ensureOpenshell).not.toHaveBeenCalled();
    expect(targetDeps.assertGatewayReadiness).not.toHaveBeenCalled();
    expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
  });

  it("pins the requested gateway for route and forward checks, then restores it", async () => {
    process.env.OPENSHELL_GATEWAY = "before";
    const seen: string[] = [];
    const observeForwardPorts = vi.fn<OpenShellForwardPortObserver>(async (ports) => {
      seen.push(`forward:${process.env.OPENSHELL_GATEWAY}`);
      return forwardObserver("owned")(ports);
    });
    await preflightAuthoritativeRebuildTarget(
      target,
      deps({
        inferenceRouteState: vi.fn((): InferenceRouteState => {
          seen.push(`route:${process.env.OPENSHELL_GATEWAY}`);
          return "matched";
        }),
        observeForwardPorts,
      }),
    );

    expect(seen).toEqual(["route:nemoclaw-12345", "forward:nemoclaw-12345"]);
    expect(observeForwardPorts).toHaveBeenCalledWith([18789]);
    expect(process.env.OPENSHELL_GATEWAY).toBe("before");
  });

  it("rejects an exact provider/model route mismatch", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ inferenceRouteState: vi.fn((): InferenceRouteState => "mismatched") }),
      ),
    ).rejects.toThrow("inference route does not match");
  });

  const nvidiaSelection = {
    provider: "nvidia-prod",
    nativeNvidiaProviderAttachment: {
      schemaVersion: 1 as const,
      profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
      providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
      providerId: "recorded-provider-id",
    },
  } satisfies Omit<SandboxEntry, "name">;
  const openai = HOSTED_NATIVE_PROVIDERS[0];
  const hostedAttachment = {
    schemaVersion: 1 as const,
    profileId: openai.profileId,
    providerName: openai.providerName,
    providerId: "recorded-provider-id",
  };

  function nativeRuntime(selection: Omit<SandboxEntry, "name">) {
    const sandboxes: Record<string, SandboxEntry> = {
      [target.sandboxName]: {
        ...selection,
        name: target.sandboxName,
        dashboardRemoteBindPrepared: true,
      },
    };
    const getSandbox = vi.fn((name: string) => sandboxes[name] ?? null);
    const capture = vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 0,
      output: "Name: alpha\nPhase: Ready\n",
      stdout: "Name: alpha\nPhase: Ready\n",
      stderr: "",
    });
    const forward = {
      gatewayEndpoint: "https://127.0.0.1:12345",
      gatewayName: target.targetGatewayName,
      workspace: "default",
      sandboxName: target.sandboxName,
      localHost: "0.0.0.0" as const,
      port: target.controlUiPort,
    };
    const observeForwards = vi
      .fn<OpenShellForwardAdapter["observeForwards"]>()
      .mockResolvedValue([{ state: "owned", forward }]);
    const createAdapter = vi
      .spyOn(forwardRuntime, "createOpenShellForwardAdapterForAuthority")
      .mockReturnValue({
        observeForwards,
        startForward: vi.fn(),
        retireLegacyForward: vi.fn(),
        verifyForwardRelease: vi.fn(),
      });
    // Use the same CommonJS module as the production factory's lazy verifier import.
    const inferenceRouteHealth: typeof import("../actions/sandbox/inference-route-health") = require("../actions/sandbox/inference-route-health");
    const verify = vi
      .spyOn(inferenceRouteHealth, "verifyNativeHostedStatusAttachment")
      .mockResolvedValue(undefined);
    const authority = {
      gatewayEndpoint: forward.gatewayEndpoint,
      localTlsDir: "/recorded/gateway/tls",
    };
    return {
      dependencies: runtimePreflightDependencies(target, authority, { getSandbox }, {}),
      getSandbox,
      capture,
      verify,
      createAdapter,
      observeForwards,
      authority,
      forward,
    };
  }

  it.each([
    {
      selection: nvidiaSelection,
      attachment: nvidiaSelection.nativeNvidiaProviderAttachment,
    },
    {
      selection: {
        provider: openai.logicalProvider,
        nativeHostedProviderAttachment: hostedAttachment,
      },
      attachment: hostedAttachment,
    },
  ])(
    "verifies the $selection.provider attachment instead of a shared route",
    async ({ selection, attachment }) => {
      process.env.OPENSHELL_GATEWAY = "unrelated-gateway";
      const runtime = nativeRuntime(selection);
      const targetDeps = deps({
        ...runtime.dependencies,
        inferenceRouteState: vi.fn((): InferenceRouteState => "mismatched"),
      });

      await preflightAuthoritativeRebuildTarget(
        { ...target, provider: selection.provider },
        targetDeps,
      );

      expect(runtime.getSandbox).toHaveBeenCalledWith("alpha");
      expect(runtime.verify).toHaveBeenCalledWith({
        gatewayName: target.targetGatewayName,
        sandboxName: "alpha",
        expected: attachment,
      });
      expect(runtime.createAdapter).toHaveBeenCalledWith({
        ...runtime.authority,
        gatewayName: target.targetGatewayName,
        workspace: "default",
      });
      expect(runtime.observeForwards).toHaveBeenCalledWith({ forwards: [runtime.forward] });
      expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
      expect(process.env.OPENSHELL_GATEWAY).toBe("unrelated-gateway");
    },
  );

  it.each([
    {
      label: "malformed attachment",
      selection: { provider: "nvidia-prod", nativeNvidiaProviderAttachment: {} },
      provider: "nvidia-prod",
      error: "Invalid native provider attachment",
    },
    {
      label: "different target provider",
      selection: nvidiaSelection,
      provider: "openai-api",
      error: "does not match the authoritative rebuild target",
    },
  ])("rejects a $label before using a shared route", async ({ selection, provider, error }) => {
    const targetDeps = deps({ getSandbox: vi.fn(() => selection) });

    await expect(
      preflightAuthoritativeRebuildTarget({ ...target, provider }, targetDeps),
    ).rejects.toThrow(error);

    expect(targetDeps.verifyNativeProviderAttachment).not.toHaveBeenCalled();
    expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
    expect(targetDeps.observeForwardPorts).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects failed native ownership verification with prepared recovery=%s",
    async (prepared) => {
      process.env.OPENSHELL_GATEWAY = "before";
      const runtime = nativeRuntime(nvidiaSelection);
      runtime.verify.mockRejectedValue(new Error("native provider identity changed"));
      const targetDeps = deps({
        ...runtime.dependencies,
      });

      await expect(
        preflightAuthoritativeRebuildTarget(
          { ...target, ...(prepared ? { deferInferenceRouteUntilOnboard: true as const } : {}) },
          targetDeps,
        ),
      ).rejects.toThrow("native provider identity changed");

      expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
      expect(runtime.observeForwards).not.toHaveBeenCalled();
      expect(process.env.OPENSHELL_GATEWAY).toBe("before");
    },
  );

  it("verifies a prepared recovery attachment on its recorded gateway while the source exists", async () => {
    const runtime = nativeRuntime(nvidiaSelection);
    await preflightAuthoritativeRebuildTarget(
      { ...target, deferInferenceRouteUntilOnboard: true },
      deps(runtime.dependencies),
    );
    expect(runtime.capture).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", target.targetGatewayName, "alpha"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(runtime.verify).toHaveBeenCalledWith({
      gatewayName: target.targetGatewayName,
      sandboxName: "alpha",
      expected: nvidiaSelection.nativeNvidiaProviderAttachment,
    });
  });

  it("defers prepared attachment inspection only after explicit source absence", async () => {
    const runtime = nativeRuntime(nvidiaSelection);
    runtime.capture.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "sandbox alpha not found",
      output: "sandbox alpha not found",
    });
    const targetDeps = deps(runtime.dependencies);
    await preflightAuthoritativeRebuildTarget(
      { ...target, deferInferenceRouteUntilOnboard: true },
      targetDeps,
    );
    expect(runtime.capture).toHaveBeenCalledOnce();
    expect(runtime.verify).not.toHaveBeenCalled();
    expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
  });

  it("preserves the source when prepared recovery cannot determine sandbox presence", async () => {
    process.env.OPENSHELL_GATEWAY = "before";
    const runtime = nativeRuntime(nvidiaSelection);
    runtime.capture.mockReturnValue({
      status: null,
      output: "",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    });
    const targetDeps = deps(runtime.dependencies);
    await expect(
      preflightAuthoritativeRebuildTarget(
        { ...target, deferInferenceRouteUntilOnboard: true },
        targetDeps,
      ),
    ).rejects.toThrow("neither presence nor explicit absence");
    expect(runtime.verify).not.toHaveBeenCalled();
    expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
    expect(runtime.observeForwards).not.toHaveBeenCalled();
    expect(process.env.OPENSHELL_GATEWAY).toBe("before");
  });

  it.each([
    { label: "ordinary rebuild", options: {} },
    {
      label: "prepared recovery",
      options: { deferInferenceRouteUntilOnboard: true as const },
    },
  ])("rejects malformed native-local authority during $label", async ({ options }) => {
    const targetDeps = deps();

    await expect(
      preflightAuthoritativeRebuildTarget(
        {
          ...target,
          ...options,
          agent: "langchain-deepagents-code",
          provider: "ollama-local",
          nativeLocalProviderAttachment: {} as never,
        },
        targetDeps,
      ),
    ).rejects.toThrow("Native local provider authority does not match the rebuild target.");

    expect(targetDeps.getSandbox).not.toHaveBeenCalled();
    expect(targetDeps.verifyNativeProviderAttachment).not.toHaveBeenCalled();
    expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
    expect(targetDeps.observeForwardPorts).not.toHaveBeenCalled();
  });

  it("proceeds when the gateway cannot answer the route query (#9310)", async () => {
    const targetDeps = deps({
      inferenceRouteState: vi.fn((): InferenceRouteState => "unanswered"),
    });

    await expect(preflightAuthoritativeRebuildTarget(target, targetDeps)).resolves.toBeUndefined();

    expect(targetDeps.inferenceRouteState).toHaveBeenCalledOnce();
  });

  it("defers route validation for prepared recovery until authoritative onboard (#6114)", async () => {
    const targetDeps = deps({
      inferenceRouteState: vi.fn((): InferenceRouteState => "mismatched"),
    });

    await expect(
      preflightAuthoritativeRebuildTarget(
        { ...target, deferInferenceRouteUntilOnboard: true },
        targetDeps,
      ),
    ).resolves.toBeUndefined();

    expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
    expect(targetDeps.runFatalRuntimePreflight).toHaveBeenCalledOnce();
    expect(targetDeps.ensureOpenshell).toHaveBeenCalledOnce();
    expect(targetDeps.getSandbox).toHaveBeenCalledWith(target.sandboxName);
    expect(targetDeps.observeSandboxPresence).not.toHaveBeenCalled();
    expect(targetDeps.verifyNativeProviderAttachment).not.toHaveBeenCalled();
  });

  it("rejects a dashboard forward owned by another sandbox", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ observeForwardPorts: forwardObserver("foreign") }),
      ),
    ).rejects.toThrow("not owned by sandbox 'alpha'");
  });

  it("accepts a port that typed observation proves absent", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ observeForwardPorts: forwardObserver("absent") }),
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts an authority-proved stale forward for the exact rebuild target", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ observeForwardPorts: forwardObserver("stale") }),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects indeterminate dashboard-port ownership", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ observeForwardPorts: forwardObserver("indeterminate") }),
      ),
    ).rejects.toThrow(/Cannot prove dashboard port 18789 ownership/);
  });

  it("skips forward observation when the rebuild has no dashboard port", async () => {
    const observer = forwardObserver("foreign");

    await expect(
      preflightAuthoritativeRebuildTarget(
        { ...target, controlUiPort: null },
        deps({
          observeForwardPorts: observer,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(observer).not.toHaveBeenCalled();
  });

  it("restores gateway scope when a fatal runtime check throws", async () => {
    process.env.OPENSHELL_GATEWAY = "before";
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          runFatalRuntimePreflight: vi.fn(() => {
            throw new Error("fatal runtime gate");
          }),
        }),
      ),
    ).rejects.toThrow("fatal runtime gate");
    expect(process.env.OPENSHELL_GATEWAY).toBe("before");
  });

  it("awaits async runtime readiness before OpenShell and route checks", async () => {
    let releaseRuntime!: () => void;
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const calls: string[] = [];
    const targetDeps = deps({
      runFatalRuntimePreflight: vi.fn(async () => {
        calls.push("runtime-start");
        await runtimeReady;
        calls.push("runtime-end");
      }),
      ensureOpenshell: vi.fn(() => calls.push("openshell")),
      assertGatewayReadiness: vi.fn(() => calls.push("gateway")),
      inferenceRouteState: vi.fn((): InferenceRouteState => {
        calls.push("route");
        return "matched";
      }),
    });

    const pending = preflightAuthoritativeRebuildTarget(target, targetDeps);
    await vi.waitFor(() => expect(calls).toEqual(["runtime-start"]));
    expect(targetDeps.ensureOpenshell).not.toHaveBeenCalled();

    releaseRuntime();
    await pending;
    expect(calls).toEqual(["runtime-start", "runtime-end", "openshell", "gateway", "route"]);
  });

  it("stops rebuild checks when async runtime readiness rejects", async () => {
    const targetDeps = deps({
      runFatalRuntimePreflight: vi.fn(async () => {
        throw new Error("gateway readiness changed");
      }),
    });

    await expect(preflightAuthoritativeRebuildTarget(target, targetDeps)).rejects.toThrow(
      "gateway readiness changed",
    );
    expect(targetDeps.ensureOpenshell).not.toHaveBeenCalled();
    expect(targetDeps.assertGatewayReadiness).not.toHaveBeenCalled();
    expect(targetDeps.inferenceRouteState).not.toHaveBeenCalled();
  });
});
