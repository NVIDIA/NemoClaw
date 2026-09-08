// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authoritativeRebuildSandboxFlowOptions,
  authoritativeRebuildRuntimePreflightOptions,
  beginAuthoritativeRebuildRuntimeSelectionScope,
  type AuthoritativeRebuildTargetDeps,
  type AuthoritativeRebuildPreflightOptions,
  preflightAuthoritativeRebuildTarget,
  rebuildProviderFlowOptions,
  resolveAuthoritativeOnboardGatewayBinding,
} from "./authoritative-rebuild-target";
import type { InferenceRouteState } from "./inference-route";
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
  it("carries only target GPU state and recorded N1x preview intent (#9292)", () => {
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
    } satisfies AuthoritativeRebuildPreflightOptions;

    expect(authoritativeRebuildRuntimePreflightOptions(options)).toEqual({
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=all",
      noGpu: false,
      allowDeferredN1xManagedVllm: true,
    });

    const { allowDeferredN1xManagedVllm: _recordedIntent, ...withoutRecordedIntent } = options;
    expect(authoritativeRebuildRuntimePreflightOptions(withoutRecordedIntent)).toEqual({
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=all",
      noGpu: false,
      allowDeferredN1xManagedVllm: false,
    });
  });
});

function deps(overrides: Partial<AuthoritativeRebuildTargetDeps> = {}) {
  return {
    resolveBaselinePolicy: vi.fn(() => ({})),
    bindGatewayAuthority: vi.fn(),
    runFatalRuntimePreflight: vi.fn(),
    ensureOpenshell: vi.fn(),
    assertGatewayReadiness: vi.fn(),
    inferenceRouteState: vi.fn((): InferenceRouteState => "matched"),
    captureForwardList: vi.fn(() => "alpha 127.0.0.1 18789 42 active"),
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
    await preflightAuthoritativeRebuildTarget(
      target,
      deps({
        inferenceRouteState: vi.fn((): InferenceRouteState => {
          seen.push(`route:${process.env.OPENSHELL_GATEWAY}`);
          return "matched";
        }),
        captureForwardList: vi.fn(() => {
          seen.push(`forward:${process.env.OPENSHELL_GATEWAY}`);
          return "alpha 127.0.0.1 18789 42 active";
        }),
      }),
    );

    expect(seen).toEqual(["route:nemoclaw-12345", "forward:nemoclaw-12345"]);
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
  });

  it("rejects a dashboard forward owned by another sandbox", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ captureForwardList: vi.fn(() => "beta 127.0.0.1 18789 42 active") }),
      ),
    ).rejects.toThrow("belongs to sandbox 'beta'");
  });

  it("defers an unlisted port collision until the post-delete ForwardTcp launch", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          captureForwardList: vi.fn(() => ""),
        }),
      ),
    ).resolves.toBeUndefined();
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
