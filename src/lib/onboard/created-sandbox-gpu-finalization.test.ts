// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import type { SandboxEntry } from "../state/registry";
import { nativeLocalIdentity, type NativeLocalBinding } from "../inference/native-local/contract";
import { createOnboardCreatedSandboxCompletion } from "./created-sandbox-finalization";
import { pendingSandboxCreateIdentityForBoundary } from "./sandbox-create/identity-boundary";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import * as registration from "./sandbox-registration";

afterEach(() => vi.restoreAllMocks());

function createCompletionFixture(
  response: "HTTP_200" | "HTTP_503" | "exec-failed",
  provider = "ollama-local",
  route: SandboxGpuCreateFlowResult["route"] = "compatibility",
  gpuEnabled = true,
  localNim = false,
) {
  const order: string[] = [];
  const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => {
    order.push("probe");
    return {
      outcome:
        response === "exec-failed"
          ? { kind: "failed", error: { kind: "timeout", message: "sandbox exec timed out" } }
          : { kind: "completed", exitCode: 0 },
      stdout: response === "exec-failed" ? "" : `${response}\n`,
      stderr: "",
    };
  });
  const commitAfterReady = vi.fn(async () => {
    order.push("commit");
  });
  const rollbackManagedStartupAfterCreateFailure = vi.fn(async () => {
    order.push("rollback");
  });
  const acknowledge = vi.fn(() => {
    order.push("acknowledge");
  });
  const published = { name: "gpu-box" } as SandboxEntry;
  const register = vi.spyOn(registration, "registerCreatedSandbox").mockImplementation(() => {
    order.push("register");
    return published;
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

  const boundary = {
    sandboxName: "gpu-box",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    route,
  };
  const selection = {
    provider,
    model: "test-model",
    preferredInferenceApi: "openai-completions",
    endpointUrl: "http://host.openshell.internal:11435/v1",
    endpointSource: "onboard" as const,
    credentialEnv: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: localNim ? "nemoclaw-nim-owned" : null,
  };
  const binding: NativeLocalBinding = {
    provider: provider as NativeLocalBinding["provider"],
    agent: "openclaw",
    endpointUrl: selection.endpointUrl,
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode: "authenticated",
    gatewayName: boundary.gatewayName,
    sandboxName: boundary.sandboxName,
  };
  const nativeLocalProviderAttachment =
    !localNim && provider.endsWith("-local")
      ? {
          ...binding,
          ...nativeLocalIdentity(binding),
          schemaVersion: 1 as const,
          providerId: "provider-1",
        }
      : undefined;
  const verifiedCreate = {
    checkpoint: pendingSandboxCreateIdentityForBoundary(boundary),
    reservation: {
      authority: {
        sandboxName: "gpu-box",
        gatewayName: "nemoclaw",
        sessionId: "session-1",
        selection,
      },
      entry: {
        name: boundary.sandboxName,
        gatewayName: boundary.gatewayName,
        gatewayPort: boundary.gatewayPort,
        provider: selection.provider,
        model: selection.model,
        endpointUrl: selection.endpointUrl,
        endpointSource: selection.endpointSource,
        preferredInferenceApi: selection.preferredInferenceApi,
        pendingRouteReservation: true,
        reservationSessionId: "session-1",
        lifecycleGeneration: boundary.lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
        pendingCreateIdentity: pendingSandboxCreateIdentityForBoundary(boundary),
        nativeLocalProviderAttachment,
      },
    },
  } as NonNullable<registration.CreatedSandboxRegistrationInput["verifiedCreate"]>;
  const getVerifiedCreateRegistrationAuthority = vi.fn(
    (): NonNullable<registration.CreatedSandboxRegistrationInput["verifiedCreate"]> =>
      verifiedCreate,
  );
  const completion = createOnboardCreatedSandboxCompletion(
    "gpu-box",
    null,
    null,
    null,
    null,
    { customOpenClawImage: false, isManagedDcodeAgent: false },
    selection,
    { createIntent: null, resolvedCreateIntent: { policy: { options: {} } } },
    {
      gpuEnabled,
      hostGpuDetected: true,
      sandboxGpuEnabled: gpuEnabled,
      sandboxGpuMode: gpuEnabled ? "1" : "none",
      sandboxGpuDevice: null,
      sandboxGpuProof: null,
      openshellDriver: "docker",
      openshellVersion: "0.0.116",
    },
    false,
    { toolDisclosure: undefined, dcodeAutoApprovalMode: "disabled" },
    { webSearchConfig: null, hermesAuthMethod: null },
    { plannedMessagingState: undefined, hermesToolGateways: [] },
    null,
    { gatewayName: "nemoclaw", gatewayPort: 8080 },
    {
      initialSandboxPolicy: { appliedPresets: [], policyPath: "/private/initial-policy.yaml" },
      compatibilityPolicyPath: null,
      dashboardRemoteBindPrepared: false,
      getVerifiedCreateBoundary: () => boundary,
      getVerifiedCreateRegistrationAuthority,
      revalidateSandboxIdentity: vi.fn(),
      persistFinalHandoffAcknowledgement: acknowledge,
      persistFinalHandoffCommitStarted: vi.fn(),
    },
    null,
    "build-1",
    {
      hostGpuPlatform: "linux",
      sandboxGpuEnabled: gpuEnabled,
      sandboxGpuDevice: null,
    },
    true,
    vi.fn(),
    vi.fn(),
    "http://127.0.0.1:18789",
    { config: null, enabled: false },
    vi.fn(),
    vi.fn(),
    vi.fn(),
    { runtimeProvider: null, ensurePreparedWorkload: vi.fn(), ensurePreparedProfile: vi.fn() },
    {
      source: {
        kind: "legacy-dockerfile",
        dockerfilePath: "/workspace/Dockerfile",
        reason: "agent-not-managed",
      },
      release: null,
      fallbackDiagnostic: null,
    },
    vi.fn(),
    { runBuffered },
    () => undefined,
  );
  const created: SandboxGpuCreateFlowResult = {
    origin: "created",
    route,
    createResult: { status: 0, output: "", sawProgress: true },
    firstCreateOutput: "",
    registryImageRef: "sandbox:test",
    lifecycleRegistrationFields: { lifecycleGeneration: "generation-1" },
    runtimePatch: {
      commitAfterReady,
      rollbackManagedStartupAfterCreateFailure,
      maybeApplyDuringCreate: vi.fn(),
      createFailureMessage: () => null,
      exitOnPatchError: vi.fn(),
      ensureApplied: vi.fn(),
      waitForSupervisorReconnectIfNeeded: vi.fn(),
      selectedMode: () => null,
      printReadinessFailureIfEnabled: vi.fn(),
      verifyGpuOrExit: vi.fn(),
    },
  };
  const identity = {
    lifecycleGeneration: boundary.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
  };
  const complete = () =>
    completion.complete(
      created,
      null,
      gpuEnabled ? "created" : "disabled",
      false,
      () => ({ lifecycleGeneration: "generation-1" }),
      {
        generation: "generation-1",
        recordExactIdentity: async () => identity,
        capture: async () => identity,
        revalidate: async (captured: typeof identity) => captured,
      },
    );
  return {
    complete,
    verifiedCreate,
    getVerifiedCreateRegistrationAuthority,
    runBuffered,
    commitAfterReady,
    rollbackManagedStartupAfterCreateFailure,
    acknowledge,
    register,
    order,
    logError,
  };
}

describe("GPU inference verification in production finalization", () => {
  it.each(["ollama-local", "vllm-local"])(
    "probes the native %s route before committing and registering the GPU sandbox (#14069)",
    async (provider) => {
      const fixture = createCompletionFixture("HTTP_200", provider);
      await fixture.complete();

      expect(fixture.runBuffered).toHaveBeenCalledExactlyOnceWith({
        sandboxName: "gpu-box",
        target: { kind: "named", gatewayName: "nemoclaw" },
        command: [
          "sh",
          "-c",
          expect.stringContaining("http://host.openshell.internal:11435/v1/models"),
        ],
        timeoutMilliseconds: 15000,
      });
      const script = fixture.runBuffered.mock.calls[0][0].command[2];
      expect(script).toContain(' -H "$AUTH_HEADER"');
      expect(script).not.toContain("inference.local");
      expect(fixture.order).toEqual(["probe", "commit", "acknowledge", "register"]);
      expect(fixture.rollbackManagedStartupAfterCreateFailure).not.toHaveBeenCalled();
    },
  );

  it.each(["HTTP_503", "exec-failed"] as const)(
    "rolls back without committing or registering when the sandbox probe returns %s (#12217)",
    async (response) => {
      const fixture = createCompletionFixture(response);
      await expect(fixture.complete()).rejects.toThrow(
        "GPU sandbox local inference reachability failed",
      );

      expect(fixture.order).toEqual(["probe", "rollback"]);
      expect(fixture.commitAfterReady).not.toHaveBeenCalled();
      expect(fixture.acknowledge).not.toHaveBeenCalled();
      expect(fixture.register).not.toHaveBeenCalled();
      expect(fixture.logError).toHaveBeenCalledWith(
        expect.stringContaining(
          response === "HTTP_503" ? "HTTP 503" : "openshell sandbox exec did not run",
        ),
      );
    },
  );

  it("retains the shared route for Local NIM (#14069)", async () => {
    const fixture = createCompletionFixture("HTTP_200", "vllm-local", "compatibility", true, true);
    await fixture.complete();
    expect(fixture.runBuffered.mock.calls[0][0].command[2]).toContain(
      "https://inference.local/v1/models",
    );
    expect(fixture.order).toEqual(["probe", "commit", "acknowledge", "register"]);
  });

  it("rolls back a missing native attachment without probing or publishing (#14069)", async () => {
    const fixture = createCompletionFixture("HTTP_200");
    delete fixture.verifiedCreate.reservation.entry.nativeLocalProviderAttachment;
    await expect(fixture.complete()).rejects.toThrow("native local provider attachment");
    expect(fixture.order).toEqual(["rollback"]);
  });

  it.each([
    ["gateway", { gatewayName: "other-gateway" }],
    ["sandbox", { sandboxName: "other-sandbox" }],
    ["provider", { provider: "vllm-local" as const }],
    ["agent", { agent: "pi" as const }],
    ["endpoint", { endpointUrl: "http://host.openshell.internal:11436/v1" }],
    ["credential environment", { credentialEnv: "OTHER_TOKEN" }],
  ])(
    "rolls back an attachment for another %s without probing or publishing (#14069)",
    async (_field, patch) => {
      const fixture = createCompletionFixture("HTTP_200");
      const attachment = {
        ...fixture.verifiedCreate.reservation.entry.nativeLocalProviderAttachment!,
        ...patch,
      };
      fixture.verifiedCreate.reservation.entry.nativeLocalProviderAttachment = {
        ...attachment,
        ...nativeLocalIdentity(attachment),
      };
      await expect(fixture.complete()).rejects.toThrow("native local provider attachment");
      expect(fixture.order).toEqual(["rollback"]);
    },
  );

  it("rolls back mismatched verified create authority before probing (#14069)", async () => {
    const fixture = createCompletionFixture("HTTP_200");
    fixture.getVerifiedCreateRegistrationAuthority.mockReturnValue({
      ...fixture.verifiedCreate,
      checkpoint: { ...fixture.verifiedCreate.checkpoint, gatewayName: "other-gateway" },
    });
    await expect(fixture.complete()).rejects.toThrow();
    expect(fixture.order).toEqual(["rollback"]);
  });

  it("rolls back missing verified create authority before probing (#14069)", async () => {
    const fixture = createCompletionFixture("HTTP_200");
    fixture.getVerifiedCreateRegistrationAuthority.mockImplementation(() => {
      throw new Error("Verified create authority is unavailable");
    });
    await expect(fixture.complete()).rejects.toThrow();
    expect(fixture.order).toEqual(["rollback"]);
  });

  it.each([
    ["cloud provider", "nvidia-prod", "compatibility", true],
    ["native GPU route", "ollama-local", "native", true],
    ["disabled sandbox GPU", "ollama-local", "none", false],
  ] as const)(
    "skips the local GPU probe for %s (#12217)",
    async (_case, provider, route, enabled) => {
      const fixture = createCompletionFixture("exec-failed", provider, route, enabled);
      await fixture.complete();

      expect(fixture.runBuffered).not.toHaveBeenCalled();
      expect(fixture.order).toEqual(enabled ? ["commit", "acknowledge", "register"] : ["register"]);
      expect(fixture.rollbackManagedStartupAfterCreateFailure).not.toHaveBeenCalled();
    },
  );
});
