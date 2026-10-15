// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import { createOnboardCreatedSandboxCompletion } from "./created-sandbox-finalization";
import { pendingSandboxCreateIdentityForBoundary } from "./sandbox-create/identity-boundary";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import type { CreatedSandboxRegistrationInput } from "./sandbox-registration";
import * as sandboxRegistration from "./sandbox-registration";
import { normalizeManagedDcodeModelName } from "../inference/managed-dcode/identity";
import {
  createDcodeSelectionDriftReader,
  type DcodeSelectionDriftDeps,
  getDcodeSelectionDrift,
  getExpectedDcodeInferenceIdentity,
  parseDcodeInferenceIdentity,
  requiresSelectionRecreate,
  usesManagedDcodeIdentity,
} from "./dcode-selection-drift";

function driftDeps(
  run: () => string | null | undefined | Promise<string | null | undefined>,
  requestedEndpointUrl?: string | null,
): DcodeSelectionDriftDeps {
  return {
    getGatewayName: () => "nemoclaw-18081",
    requestedEndpointUrl,
    nativeProvider: true,
    commandExecutor: bufferedExecutor(run),
  };
}

function bufferedExecutor(
  run: () => string | null | undefined | Promise<string | null | undefined>,
): OpenShellSandboxBufferedCommandExecutor {
  return {
    runBuffered: vi.fn(async () => {
      const output = await run();
      return output == null
        ? {
            outcome: {
              kind: "failed" as const,
              error: { kind: "invocation" as const, message: "failed" },
            },
            stdout: "",
            stderr: "",
          }
        : {
            outcome: { kind: "completed" as const, exitCode: 0 },
            stdout: output,
            stderr: "",
          };
    }),
  };
}

function identity(
  overrides: Partial<Record<"Route" | "Provider" | "Model" | "Endpoint", string>> = {},
) {
  const provider = overrides.Provider ?? "nvidia-prod";
  return [
    "Sandbox:  alpha",
    `Route:    ${overrides.Route ?? "inference"}`,
    `Provider: ${provider}`,
    `Model:    ${overrides.Model ?? "openai:nvidia/nemotron-3-super-120b-a12b"}`,
    `Endpoint: ${
      overrides.Endpoint ??
      (provider === "nvidia-prod"
        ? "https://integrate.api.nvidia.com/v1"
        : "https://inference.local/v1")
    }`,
    "Runtime:  Deep Agents Code (terminal)",
  ].join("\n");
}

describe("live DCode selection drift", () => {
  it.each([
    [
      "openai-api",
      "openai",
      "openai-api",
      "openai:model-a",
      "https://api.openai.com/v1",
      "https://inference.local/v1",
    ],
    [
      "anthropic-prod",
      "anthropic",
      "anthropic-prod",
      "openai:model-a",
      "https://api.anthropic.com",
      "https://inference.local",
    ],
    [
      "gemini-api",
      "inference",
      "gemini-api",
      "openai:model-a",
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "https://inference.local/v1",
    ],
    [
      "openrouter-api",
      "inference",
      "openrouter",
      "openrouter:model-a",
      "https://openrouter.ai/api/v1",
      "https://inference.local/v1",
    ],
    [
      "hermes-provider",
      "inference",
      "hermes-provider",
      "openai:model-a",
      "https://login-selected.example/v1",
      "https://inference.local/v1",
    ],
  ])(
    "validates %s against its recorded attachment route",
    async (provider, route, identityProvider, model, nativeEndpoint, sharedEndpoint) => {
      let endpoint = sharedEndpoint;
      const read = createDcodeSelectionDriftReader(
        bufferedExecutor(() =>
          identity({
            Route: route,
            Provider: identityProvider,
            Model: model,
            Endpoint: endpoint,
          }),
        ),
        () => "nemoclaw-18081",
      );
      expect(await read("alpha", provider, "model-a", null, nativeEndpoint, false)).toMatchObject({
        changed: false,
        unknown: false,
      });
      expect(await read("alpha", provider, "model-a", null, nativeEndpoint, true)).toMatchObject({
        changed: true,
        providerChanged: true,
        unknown: false,
      });
      endpoint = nativeEndpoint;
      expect(await read("alpha", provider, "model-a", null, nativeEndpoint, true)).toMatchObject({
        changed: false,
        unknown: false,
      });
      expect(await read("alpha", provider, "model-a", null, nativeEndpoint, false)).toMatchObject({
        changed: true,
        providerChanged: true,
        unknown: false,
      });
    },
  );

  it("preserves the existing native NVIDIA route without a hosted attachment", () => {
    expect(
      getExpectedDcodeInferenceIdentity("nvidia-prod", "model-a", null, null, false),
    ).toMatchObject({ endpoint: "https://integrate.api.nvidia.com/v1" });
  });

  it("limits the managed identity contract to stock DCode images (#6311)", () => {
    expect(usesManagedDcodeIdentity("langchain-deepagents-code", null)).toBe(true);
    expect(usesManagedDcodeIdentity("langchain-deepagents-code", "/tmp/Dockerfile")).toBe(false);
    expect(usesManagedDcodeIdentity("openclaw", null)).toBe(false);
  });

  it("fails closed only for unreadable managed DCode selection (#6311)", () => {
    expect(requiresSelectionRecreate({ changed: true, unknown: true }, true)).toBe(true);
    expect(requiresSelectionRecreate({ changed: true, unknown: true }, false)).toBe(false);
    expect(requiresSelectionRecreate({ changed: true, unknown: false }, false)).toBe(true);
  });

  it("strictly parses one value for every managed identity field (#6311)", () => {
    expect(parseDcodeInferenceIdentity(identity())).toEqual({
      route: "inference",
      provider: "nvidia-prod",
      model: "openai:nvidia/nemotron-3-super-120b-a12b",
      endpoint: "https://integrate.api.nvidia.com/v1",
    });

    expect(parseDcodeInferenceIdentity(identity().replace(/^Endpoint:.*$/m, ""))).toBeNull();
    expect(parseDcodeInferenceIdentity(`${identity()}\nProvider: nvidia-prod`)).toBeNull();
    expect(parseDcodeInferenceIdentity(identity().replace(/^Model:.*$/m, "Model:"))).toBeNull();
  });

  it("mirrors generated DCode model and route identity (#6311)", () => {
    expect(normalizeManagedDcodeModelName("  openai:model:tag  ")).toBe("model:tag");
    expect(normalizeManagedDcodeModelName("  openrouter:model:tag  ")).toBe("model:tag");
    expect(
      getExpectedDcodeInferenceIdentity(
        "compatible-anthropic-endpoint",
        "openai:model:tag",
        "anthropic-messages",
      ),
    ).toEqual({
      route: "anthropic",
      provider: "compatible-anthropic-endpoint",
      model: "openai:model:tag",
      endpoint: "https://inference.local",
    });
  });

  it("accepts the generated OpenRouter identity (#9555)", async () => {
    const output = identity({
      Provider: "openrouter",
      Model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
      Endpoint: "https://openrouter.ai/api/v1",
    });

    expect(
      await getDcodeSelectionDrift(
        "alpha",
        "openrouter-api",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        driftDeps(() => output),
      ),
    ).toEqual({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "openrouter",
      existingModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
      unknown: false,
    });
  });

  it("accepts the generated OpenRouter identity for its compatible endpoint (#9555)", async () => {
    const output = identity({
      Provider: "openrouter",
      Model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
    });
    const readDcodeSelectionDrift = createDcodeSelectionDriftReader(
      bufferedExecutor(() => output),
      () => "nemoclaw-18081",
    );

    expect(
      await readDcodeSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        "https://openrouter.ai/api/v1/",
        false,
      ),
    ).toMatchObject({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      unknown: false,
    });
  });

  it.each([
    "https://openrouter.ai:8443/api/v1",
    "https://user:password@openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1?route=other",
    "https://openrouter.ai/api/v1#route",
  ])("rejects a noncanonical OpenRouter-compatible endpoint: %s (#9555)", async (endpointUrl) => {
    const output = identity({
      Provider: "openrouter",
      Model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
    });
    const readDcodeSelectionDrift = createDcodeSelectionDriftReader(
      bufferedExecutor(() => output),
      () => "nemoclaw-18081",
    );

    expect(
      await readDcodeSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        endpointUrl,
        false,
      ),
    ).toMatchObject({
      changed: true,
      providerChanged: true,
      modelChanged: true,
      unknown: false,
    });
  });

  it("keeps ordinary compatible endpoints on the OpenAI identity (#9555)", async () => {
    const output = identity({
      Provider: "compatible-endpoint",
      Model: "openai:model-a",
    });
    const readDcodeSelectionDrift = createDcodeSelectionDriftReader(
      bufferedExecutor(() => output),
      () => "nemoclaw-18081",
    );

    expect(
      await readDcodeSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "model-a",
        null,
        "https://example.test/v1",
        false,
      ),
    ).toMatchObject({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      unknown: false,
    });
  });

  it("rejects an OpenAI identity for an OpenRouter selection (#9555)", async () => {
    expect(
      await getDcodeSelectionDrift(
        "alpha",
        "openrouter-api",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        driftDeps(() => identity()),
      ),
    ).toMatchObject({
      changed: true,
      providerChanged: true,
      modelChanged: true,
      unknown: false,
    });
  });

  it("preserves colon-bearing model IDs in expected DCode identity (#6311)", () => {
    expect(normalizeManagedDcodeModelName("minimax/minimax-m2.5:free")).toBe(
      "minimax/minimax-m2.5:free",
    );
    expect(
      getExpectedDcodeInferenceIdentity("compatible-endpoint", "minimax/minimax-m2.5:free", null),
    ).toMatchObject({ model: "openai:minimax/minimax-m2.5:free" });
  });

  it("accepts only a live identity matching the requested selection (#6311)", async () => {
    const commandExecutor = bufferedExecutor(() => identity());

    expect(
      await getDcodeSelectionDrift(
        "alpha",
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        null,
        {
          commandExecutor,
          getGatewayName: () => "nemoclaw-18081",
          nativeProvider: true,
        },
      ),
    ).toEqual({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "nvidia-prod",
      existingModel: "openai:nvidia/nemotron-3-super-120b-a12b",
      unknown: false,
    });
    expect(commandExecutor.runBuffered).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw-18081" },
      command: ["/usr/local/bin/dcode", "identity"],
    });
  });

  it.each([
    identity({ Provider: "openai-api" }),
    identity({ Route: "openai" }),
    identity({ Endpoint: "https://old.example/v1" }),
  ])(
    "reports provider drift for upstream, route, or endpoint changes [case %#] (#6311)",
    async (output) => {
      expect(
        await getDcodeSelectionDrift(
          "alpha",
          "nvidia-prod",
          "nvidia/nemotron-3-super-120b-a12b",
          null,
          driftDeps(() => output),
        ),
      ).toMatchObject({
        changed: true,
        providerChanged: true,
        modelChanged: false,
        unknown: false,
      });
    },
  );

  it("reports model drift from the live DCode config (#6311)", async () => {
    expect(
      await getDcodeSelectionDrift(
        "alpha",
        "nvidia-prod",
        "new-model",
        null,
        driftDeps(() => identity({ Model: "openai:old-model" })),
      ),
    ).toMatchObject({
      changed: true,
      providerChanged: false,
      modelChanged: true,
      existingModel: "openai:old-model",
      unknown: false,
    });
  });

  it.each([
    ["missing output", () => null],
    ["malformed output", () => identity().replace(/^Route:.*$/m, "Route:")],
    [
      "failed command",
      () => {
        throw new Error("sandbox unavailable");
      },
    ],
  ])("fails closed for %s (#6311)", async (_name, runCaptureOpenshell) => {
    expect(
      await getDcodeSelectionDrift(
        "alpha",
        "nvidia-prod",
        "model-a",
        null,
        driftDeps(runCaptureOpenshell),
      ),
    ).toEqual({
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      unknown: true,
    });
  });
});

describe("DCode selection through production completion", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      behavior: "rejects a shared identity for an OpenRouter selection",
      endpointUrl: "https://openrouter.ai/api/v1",
      attachmentEndpoint: undefined,
      observedEndpoint: "https://inference.local/v1",
      observedModel: "openai:nvidia/nemotron-3-ultra-550b-a55b",
      expectedError: "exit 1",
      registrationCount: 0,
    },
    {
      behavior: "accepts the authenticated native local identity",
      endpointUrl: "http://localhost:8000/v1",
      attachmentEndpoint: "http://host.openshell.internal:8000/v1",
      observedEndpoint: "http://host.openshell.internal:8000/v1",
      observedModel: "openai:nvidia/nemotron-3-ultra-550b-a55b",
      expectedError: "registration reached",
      registrationCount: 1,
    },
    {
      behavior: "accepts the native identity of the credentialless endpoint bridge",
      endpointUrl: "http://localhost:8000/v1",
      attachmentEndpoint: "http://host.openshell.internal:11435/v1",
      observedEndpoint: "http://host.openshell.internal:11435/v1",
      observedModel: "openai:nvidia/nemotron-3-ultra-550b-a55b",
      expectedError: "registration reached",
      registrationCount: 1,
    },
    {
      behavior: "rejects a shared identity for a native local attachment",
      endpointUrl: "http://localhost:8000/v1",
      attachmentEndpoint: "http://host.openshell.internal:8000/v1",
      observedEndpoint: "https://inference.local/v1",
      observedModel: "openai:nvidia/nemotron-3-ultra-550b-a55b",
      expectedError: "exit 1",
      registrationCount: 0,
    },
    {
      behavior: "rejects model drift on a native local attachment",
      endpointUrl: "http://localhost:8000/v1",
      attachmentEndpoint: "http://host.openshell.internal:8000/v1",
      observedEndpoint: "http://host.openshell.internal:8000/v1",
      observedModel: "openai:wrong-model",
      expectedError: "exit 1",
      registrationCount: 0,
    },
    {
      behavior: "accepts the shared identity of a nonlocal custom endpoint",
      endpointUrl: "https://custom.example/v1",
      attachmentEndpoint: undefined,
      observedEndpoint: "https://inference.local/v1",
      observedModel: "openai:nvidia/nemotron-3-ultra-550b-a55b",
      expectedError: "registration reached",
      registrationCount: 1,
    },
  ])(
    "$behavior through the production completion constructor (#13197)",
    async ({
      endpointUrl,
      attachmentEndpoint,
      observedEndpoint,
      observedModel,
      expectedError,
      registrationCount,
    }) => {
      const model = "nvidia/nemotron-3-ultra-550b-a55b";
      // Stop at the registry write boundary after the real drift reader runs.
      const register = vi
        .spyOn(sandboxRegistration, "registerCreatedSandbox")
        .mockImplementation(() => {
          throw new Error("registration reached");
        });
      const verifiedCreateBoundary = {
        sandboxName: "dcode",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "native" as const,
      };
      const verifiedCreate = {
        reservation: { authority: { selection: {} } } as never,
        checkpoint: pendingSandboxCreateIdentityForBoundary(verifiedCreateBoundary),
      } as NonNullable<CreatedSandboxRegistrationInput["verifiedCreate"]>;
      const runCaptureOpenshell = vi.fn(() =>
        [
          "Sandbox:  dcode",
          "Route:    inference",
          "Provider: compatible-endpoint",
          `Model:    ${observedModel}`,
          `Endpoint: ${observedEndpoint}`,
          "Runtime:  Deep Agents Code (terminal)",
        ].join("\n"),
      );
      const runBuffered = vi.fn(async () => ({
        outcome: { kind: "completed" as const, exitCode: 0 },
        stdout: runCaptureOpenshell(),
        stderr: "",
      }));
      vi.spyOn(process, "exit").mockImplementation((code): never => {
        throw new Error(`exit ${code}`);
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      const completionArgs = [
        "dcode",
        null,
        null,
        null,
        null,
        { customOpenClawImage: false, isManagedDcodeAgent: true },
        {
          provider: "compatible-endpoint",
          model,
          preferredInferenceApi: "openai-completions",
          endpointUrl,
        },
        {
          createIntent: {
            endpointUrl,
            endpointSource: null,
            observabilityEnabled: false,
          },
          resolvedCreateIntent: {
            nativeLocalProviderAttachment: attachmentEndpoint
              ? { endpointUrl: attachmentEndpoint }
              : undefined,
            policy: { options: {} },
            hostMounts: undefined,
          },
        },
        {
          gpuEnabled: false,
          hostGpuDetected: false,
          sandboxGpuEnabled: false,
          sandboxGpuMode: "none",
          sandboxGpuDevice: null,
          sandboxGpuProof: null,
          openshellDriver: "docker",
          openshellVersion: "0.0.101",
        },
        false,
        { toolDisclosure: undefined, dcodeAutoApprovalMode: "disabled" },
        { webSearchConfig: null, hermesAuthMethod: null },
        {
          plannedMessagingState: undefined,
          preservedMcpState: undefined,
          hermesToolGateways: [],
        },
        null,
        { gatewayName: "nemoclaw", gatewayPort: 8080 },
        {
          initialSandboxPolicy: {
            appliedPresets: ["personal-open-internet"],
            policyPath: "/private/initial-policy.yaml",
          },
          compatibilityPolicyPath: null,
          dashboardRemoteBindPrepared: false,
          getVerifiedCreateBoundary: () => verifiedCreateBoundary,
          getVerifiedCreateRegistrationAuthority: () => verifiedCreate,
          revalidateSandboxIdentity: vi.fn(),
        },
        null,
        "build-1",
        {
          mode: "none",
          hostGpuDetected: false,
          hostGpuPlatform: "linux",
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
        false,
        vi.fn(),
        runCaptureOpenshell,
        "http://127.0.0.1:8643",
        { config: null, enabled: false },
        vi.fn(),
        vi.fn(),
        vi.fn(),
        {
          runtimeProvider: null,
          ensurePreparedWorkload: vi.fn(),
          ensurePreparedProfile: vi.fn(),
        },
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
      ] as unknown as Parameters<typeof createOnboardCreatedSandboxCompletion>;
      const completion = createOnboardCreatedSandboxCompletion(...completionArgs);
      const created = {
        createResult: { status: 0, output: "", sawProgress: true },
        route: "native",
        firstCreateOutput: "",
        registryImageRef: null,
        lifecycleRegistrationFields: { lifecycleGeneration: "generation-1" },
      } as SandboxGpuCreateFlowResult;
      const lifecycleLiveIdentityFingerprint = "a".repeat(64);
      const lifecycle = {
        generation: "generation-1",
        recordExactIdentity: () => ({
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint,
        }),
        capture: () => ({
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint,
        }),
        revalidate: (registration: {
          lifecycleGeneration: string;
          lifecycleLiveIdentityFingerprint: string;
        }) => registration,
      };

      await expect(
        completion.complete(
          created,
          null,
          "disabled",
          false,
          () => ({ lifecycleGeneration: "generation-1" }),
          lifecycle,
        ),
      ).rejects.toThrow(expectedError);
      expect(runBuffered).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledTimes(registrationCount);
    },
  );
});
