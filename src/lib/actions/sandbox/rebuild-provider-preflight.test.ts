// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import {
  HOSTED_NATIVE_PROVIDERS,
  hostedNativeProvider,
} from "../../inference/native-provider/hosted";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import {
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
} from "../../inference/native-nvidia";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import type { GatewayProviderMetadata } from "../../onboard/gateway-provider-metadata";
import {
  canRecreateMissingRebuildGatewayProvider,
  checkRebuildGatewayCredentialReuseOrBail,
  checkRebuildGatewayProviderOrBail,
  inspectRebuildGatewayProviderRegistration,
  shouldVerifyRebuildGatewayProvider,
  verifyRebuildNativeLocalProviderBeforeDelete,
  verifyRebuildRegisteredProviderBeforeDelete,
} from "./rebuild-provider-preflight";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import * as managedProviderAdapter from "../../adapters/openshell/managed-provider-adapter";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { nativeLocalIdentity } from "../../inference/native-local/contract";
import { preflightRebuildCredentials } from "./rebuild-credential-preflight";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import * as hostCredentialPreflight from "./rebuild/host-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";

vi.mock("../../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

const exactGatewayProvider: GatewayProviderMetadata = {
  name: "compatible-endpoint",
  type: "openai",
  credentialKeys: ["COMPATIBLE_API_KEY"],
  configKeys: ["OPENAI_BASE_URL"],
};

const noAuthGatewayProvider: GatewayProviderMetadata = {
  name: "compatible-endpoint",
  type: "openai",
  credentialKeys: ["NEMOCLAW_OLLAMA_PROXY_TOKEN"],
  configKeys: ["OPENAI_BASE_URL"],
};

function config(overrides: Partial<RebuildResumeConfig> = {}): RebuildResumeConfig {
  return {
    agent: null,
    provider: "compatible-endpoint",
    model: "nvidia/model",
    nimContainer: null,
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    pinEndpoint: true,
    endpointUrl: "https://inference.example.test/v1",
    registryInferenceRoute: {
      provider: "compatible-endpoint",
      model: "nvidia/model",
      endpointUrl: "https://inference.example.test/v1",
      preferredInferenceApi: "openai-completions",
      source: "registry",
    },
    ambient: { presentVars: [], agentMismatch: null },
    ...overrides,
  };
}

const throwingBail = (message: string): never => {
  throw new Error(message);
};

describe.each(["langchain-deepagents-code", "hermes", "openclaw"] as const)(
  "native local rebuild credentials for %s",
  (agent) => {
    function nativeFixture() {
      const binding = {
        agent: agent === "langchain-deepagents-code" ? undefined : agent,
        provider:
          agent === "openclaw" ? ("llama-cpp-local" as const) : ("compatible-endpoint" as const),
        endpointUrl: "http://host.openshell.internal:8000/v1",
        credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        authMode: "authenticated" as const,
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
      };
      const attachment = {
        ...binding,
        ...nativeLocalIdentity(binding),
        schemaVersion: 1 as const,
        providerId: "owned",
      };
      const adapter = {
        inspectProviderProfile: vi.fn(async () => ({
          ok: true,
          value: { credentialKeys: [binding.credentialEnv] },
        })),
        getProvider: vi.fn(async () => ({
          ok: true,
          value: {
            name: attachment.providerName,
            type: attachment.profileId,
            credentialKeys: [binding.credentialEnv],
            configKeys: [],
            credentialExpiresAtMs: {} as Record<string, number> | undefined,
            revision: { id: "owned", resourceVersion: 1 },
          },
        })),
        listProviderAttachments: vi.fn(async () => ({
          ok: true,
          value: { names: [attachment.providerName] },
        })),
      };
      vi.spyOn(managedProviderAdapter, "createManagedProviderAdapter").mockReturnValue(
        adapter as unknown as OpenShellProviderAdapter,
      );
      const hydrate = vi
        .spyOn(rebuildOnboardDependencies, "hydrateCredentialEnv")
        .mockReturnValue(null);
      const selection = config({
        agent,
        provider: binding.provider,
        endpointUrl: "http://localhost:8000/v1",
        nativeLocalProviderAttachment: attachment,
      });
      const entry = {
        ...selection,
        name: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      } as unknown as RebuildSandboxEntry;
      return { attachment, adapter, selection, entry, hydrate };
    }

    it("reuses the native credential without requiring a shared registration or host key (#13197)", async () => {
      const f = nativeFixture();
      const readShared = vi.fn();
      await expect(preflightRebuildCredentials(f.entry, vi.fn(), throwingBail)).resolves.toBe(true);
      await expect(
        checkRebuildGatewayCredentialReuseOrBail(
          "alpha",
          f.selection,
          false,
          vi.fn(),
          throwingBail,
          {
            readGatewayProviderMetadata: readShared,
            readRecordedProviderEndpoints: vi.fn(),
          },
        ),
      ).resolves.toBe(true);
      expect(f.adapter.getProvider.mock.calls).toEqual([
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            providerName: f.attachment.providerName,
            includeCredentialExpirations: true,
          },
        ],
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            providerName: f.attachment.providerName,
          },
        ],
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            providerName: f.attachment.providerName,
            includeCredentialExpirations: true,
          },
        ],
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            providerName: f.attachment.providerName,
          },
        ],
      ]);
      expect(readShared).not.toHaveBeenCalled();
    });

    it("revalidates exact scoped authority before delete without a shared provider", async () => {
      const f = nativeFixture();
      const getSandbox = vi.fn(() => f.entry);
      await expect(
        verifyRebuildNativeLocalProviderBeforeDelete(
          "alpha",
          "nemoclaw",
          f.selection,
          {
            gatewayName: "nemoclaw",
            workspace: "/selected-workspace",
            localTlsDir: "/selected-tls",
          },
          getSandbox,
        ),
      ).resolves.toBe(true);
      expect(getSandbox.mock.calls).toEqual([["alpha"], ["alpha"]]);
      expect(f.adapter.inspectProviderProfile).toHaveBeenCalledOnce();
      expect(f.adapter.getProvider.mock.calls).toEqual([
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            providerName: f.attachment.providerName,
            includeCredentialExpirations: true,
          },
        ],
        [
          {
            target: { kind: "named", gatewayName: "nemoclaw" },
            providerName: f.attachment.providerName,
          },
        ],
      ]);
      expect(f.adapter.listProviderAttachments).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      });
    });

    it.each([
      { label: "expired", metadata: { NEMOCLAW_LOCAL_INFERENCE_TOKEN: 1 }, accepted: false },
      { label: "missing expiry inventory", metadata: undefined, accepted: false },
      {
        label: "negative expiry",
        metadata: { NEMOCLAW_LOCAL_INFERENCE_TOKEN: -1 },
        accepted: false,
      },
      {
        label: "invalid expiry",
        metadata: { NEMOCLAW_LOCAL_INFERENCE_TOKEN: NaN },
        accepted: false,
      },
      {
        label: "fractional expiry",
        metadata: { NEMOCLAW_LOCAL_INFERENCE_TOKEN: 1.5 },
        accepted: false,
      },
      {
        label: "explicit non-expiring",
        metadata: { NEMOCLAW_LOCAL_INFERENCE_TOKEN: 0 },
        accepted: true,
      },
      {
        label: "future expiry",
        metadata: { NEMOCLAW_LOCAL_INFERENCE_TOKEN: Number.MAX_SAFE_INTEGER },
        accepted: true,
      },
    ])("checks $label credentials at the delete edge", async ({ metadata, accepted }) => {
      const f = nativeFixture();
      const observed = await f.adapter.getProvider();
      f.adapter.getProvider.mockClear().mockResolvedValue({
        ...observed,
        value: { ...observed.value, credentialExpiresAtMs: metadata },
      });
      await expect(
        verifyRebuildNativeLocalProviderBeforeDelete(
          "alpha",
          "nemoclaw",
          f.selection,
          undefined,
          () => f.entry,
        ),
      ).resolves.toBe(accepted);
    });

    it.each([
      { label: "provider replacement", revision: { id: "replacement", resourceVersion: 1 } },
      { label: "credential update", revision: { id: "owned", resourceVersion: 2 } },
    ])("rejects $label during expiry observation", async ({ revision }) => {
      const f = nativeFixture();
      const observed = await f.adapter.getProvider();
      f.adapter.getProvider
        .mockClear()
        .mockResolvedValueOnce(observed)
        .mockResolvedValue({
          ...observed,
          value: { ...observed.value, revision },
        });
      await expect(
        verifyRebuildNativeLocalProviderBeforeDelete(
          "alpha",
          "nemoclaw",
          f.selection,
          undefined,
          () => f.entry,
        ),
      ).resolves.toBe(false);
    });

    it.each([
      {
        label: "profile drift",
        setup: (f: ReturnType<typeof nativeFixture>) =>
          f.adapter.inspectProviderProfile.mockRejectedValue(
            new Error("secret profile diagnostic"),
          ),
      },
      {
        label: "provider replacement",
        setup: (f: ReturnType<typeof nativeFixture>) =>
          f.adapter.getProvider.mockResolvedValue({
            ok: true,
            value: {
              name: f.attachment.providerName,
              type: f.attachment.profileId,
              credentialKeys: [f.attachment.credentialEnv],
              configKeys: [],
              credentialExpiresAtMs: {},
              revision: { id: "replacement", resourceVersion: 2 },
            },
          }),
      },
      {
        label: "detached attachment",
        setup: (f: ReturnType<typeof nativeFixture>) =>
          f.adapter.listProviderAttachments.mockResolvedValue({ ok: true, value: { names: [] } }),
      },
    ])("refuses $label at the delete edge", async ({ setup }) => {
      const f = nativeFixture();
      setup(f);
      await expect(
        verifyRebuildNativeLocalProviderBeforeDelete(
          "alpha",
          "nemoclaw",
          f.selection,
          undefined,
          () => f.entry,
        ),
      ).resolves.toBe(false);
    });

    it.each([
      { label: "missing registry entry", change: (_entry: RebuildSandboxEntry) => null },
      {
        label: "agent replacement",
        change: (entry: RebuildSandboxEntry) => ({ ...entry, agent: "pi" }),
      },
      {
        label: "provider replacement",
        change: (entry: RebuildSandboxEntry) => ({ ...entry, provider: "ollama-local" }),
      },
      {
        label: "receipt replacement",
        change: (entry: RebuildSandboxEntry) => ({
          ...entry,
          nativeLocalProviderAttachment: {
            ...entry.nativeLocalProviderAttachment!,
            providerId: "replacement",
          },
        }),
      },
    ])("refuses $label during asynchronous verification", async ({ change }) => {
      const f = nativeFixture();
      const getSandbox = vi
        .fn<() => RebuildSandboxEntry | null>()
        .mockReturnValueOnce(f.entry)
        .mockReturnValue(change(f.entry));
      await expect(
        verifyRebuildNativeLocalProviderBeforeDelete(
          "alpha",
          "nemoclaw",
          f.selection,
          undefined,
          getSandbox,
        ),
      ).resolves.toBe(false);
      expect(f.adapter.listProviderAttachments).toHaveBeenCalledOnce();
    });

    it("refuses a foreign runtime gateway before provider reads", async () => {
      const f = nativeFixture();
      await expect(
        verifyRebuildNativeLocalProviderBeforeDelete(
          "alpha",
          "nemoclaw",
          f.selection,
          { gatewayName: "foreign", workspace: "/foreign" },
          () => f.entry,
        ),
      ).resolves.toBe(false);
      expect(f.adapter.inspectProviderProfile).not.toHaveBeenCalled();
      expect(f.adapter.getProvider).not.toHaveBeenCalled();
      expect(f.adapter.listProviderAttachments).not.toHaveBeenCalled();
    });

    it("still rejects a staged host credential that cannot recreate native access (#13197)", async () => {
      const f = nativeFixture();
      f.hydrate.mockReturnValue("test-only-rejected-key");
      const validate = vi
        .spyOn(hostCredentialPreflight, "validateRebuildHostInferenceCredential")
        .mockResolvedValue(false);
      await expect(preflightRebuildCredentials(f.entry, vi.fn(), throwingBail)).rejects.toThrow(
        "Host inference credential validation failed",
      );
      expect(validate).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: f.selection.provider,
          credentialEnv:
            agent === "openclaw" ? "NEMOCLAW_LLAMACPP_LOCAL_TOKEN" : "COMPATIBLE_API_KEY",
        }),
        "test-only-rejected-key",
        undefined,
        expect.any(Function),
      );
    });

    it.each([false, true])(
      "rejects detached native credentials even with host key available=%s (#13197)",
      async (hostKey) => {
        const f = nativeFixture();
        f.adapter.listProviderAttachments.mockResolvedValue({ ok: true, value: { names: [] } });
        await expect(preflightRebuildCredentials(f.entry, vi.fn(), throwingBail)).rejects.toThrow(
          "Could not verify native local provider credentials",
        );
        await expect(
          checkRebuildGatewayCredentialReuseOrBail(
            "alpha",
            f.selection,
            hostKey,
            vi.fn(),
            throwingBail,
          ),
        ).rejects.toThrow("Could not verify native local provider credential reuse");
      },
    );
  },
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("shouldVerifyRebuildGatewayProvider", () => {
  it("requires remote registrations while allowing reconstructible local registrations", async () => {
    expect(shouldVerifyRebuildGatewayProvider("nvidia-prod")).toBe(true);
    expect(shouldVerifyRebuildGatewayProvider("ollama-local")).toBe(false);
    expect(shouldVerifyRebuildGatewayProvider("vllm-local")).toBe(false);

    const log = vi.fn();
    const bail = vi.fn(() => {
      throw new Error("local provider must not require an existing gateway registration");
    });
    await expect(checkRebuildGatewayProviderOrBail("ollama-local", null, log, bail)).resolves.toBe(
      true,
    );
    expect(log).not.toHaveBeenCalled();
    expect(bail).not.toHaveBeenCalled();
  });

  it("does not print malformed provider or credential identifiers", async () => {
    const adapter = createCliOpenShellProviderAdapter();
    vi.spyOn(adapter, "getProvider").mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "missing" },
    });
    vi.spyOn(managedProviderAdapter, "createManagedProviderAdapter").mockReturnValue(adapter);
    const output: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message = "") => output.push(String(message)));
    const log = vi.fn((message: string) => output.push(message));
    const secret = "nvapi-test-secret";

    await expect(
      checkRebuildGatewayProviderOrBail(
        `provider\n${secret}`,
        `CREDENTIAL\n${secret}`,
        log,
        throwingBail,
      ),
    ).rejects.toThrow("Missing gateway provider: unavailable");

    expect(output.join("\n")).not.toContain(secret);
    expect(output.join("\n")).toContain("provider 'unavailable'");
  });
});

describe("canRecreateMissingRebuildGatewayProvider", () => {
  it("requires a canonical provider and its exact credential binding (#6114)", async () => {
    expect(
      canRecreateMissingRebuildGatewayProvider("compatible-endpoint", "COMPATIBLE_API_KEY"),
    ).toBe(true);
    expect(canRecreateMissingRebuildGatewayProvider("compatible-endpoint", "OPENAI_API_KEY")).toBe(
      false,
    );
    expect(canRecreateMissingRebuildGatewayProvider("mystery-provider", "MYSTERY_API_KEY")).toBe(
      false,
    );
    expect(canRecreateMissingRebuildGatewayProvider("nvidia-nim", "NVIDIA_INFERENCE_API_KEY")).toBe(
      true,
    );
    expect(canRecreateMissingRebuildGatewayProvider("nvidia-nim", "NVIDIA_API_KEY")).toBe(false);
  });
});

describe("inspectRebuildGatewayProviderRegistration", () => {
  it.each([
    ["exact native binding", {}, "registered"],
    ["replaced provider", { revision: { id: "foreign", resourceVersion: 2 } }, "indeterminate"],
    ["wrong profile", { type: "openai" }, "indeterminate"],
    [
      "extra credential",
      { credentialKeys: ["NVIDIA_INFERENCE_API_KEY", "OTHER"] },
      "indeterminate",
    ],
    ["mutable endpoint", { configKeys: ["OPENAI_BASE_URL"] }, "indeterminate"],
    ["expired credential", { credentialExpiresAtMs: { NVIDIA_INFERENCE_API_KEY: 1 } }, "expired"],
  ] as const)(
    "checks %s against the recorded native identity",
    async (_label, changes, expected) => {
      const adapter = createCliOpenShellProviderAdapter();
      const get = vi.spyOn(adapter, "getProvider").mockResolvedValue({
        ok: true,
        value: {
          name: NVIDIA_HOSTED_NATIVE_PROVIDER,
          type: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
          credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
          configKeys: [],
          credentialExpiresAtMs: {},
          revision: { id: "recorded-id", resourceVersion: 1 },
          ...changes,
        },
      });
      const receipt = {
        schemaVersion: 1,
        providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
        profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
        providerId: "recorded-id",
      } as const;
      await expect(
        inspectRebuildGatewayProviderRegistration(
          "nvidia-prod",
          vi.fn(),
          "Before deletion",
          undefined,
          adapter,
          "NVIDIA_INFERENCE_API_KEY",
          receipt,
        ),
      ).resolves.toBe(expected);
      expect(get).toHaveBeenCalledWith(
        expect.objectContaining({
          providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
          includeCredentialExpirations: true,
        }),
      );
    },
  );

  it("pins the delete-edge lookup to the frozen target under hostile ambient selectors (#10514)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const runOpenshell = vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "provider not found",
    } as never);
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };

    await expect(
      inspectRebuildGatewayProviderRegistration(
        "compatible-endpoint",
        vi.fn(),
        "Delete-edge",
        runtimeSelection,
      ),
    ).resolves.toBe("missing");

    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "get", "compatible-endpoint"],
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "recorded-gateway",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
    const env = runOpenshell.mock.calls[0]?.[1]?.env as Record<string, string>;
    expect(env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
  });
});

describe("checkRebuildGatewayCredentialReuseOrBail", () => {
  it("accepts an exact complete registry route and gateway provider identity", async () => {
    await expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), false, vi.fn(), throwingBail, {
        readGatewayProviderMetadata: async () => exactGatewayProvider,
        readRecordedProviderEndpoints: () => [],
      }),
    ).resolves.toBe(true);
  });

  it("accepts the loopback no-auth proxy identity recorded by onboarding", async () => {
    const noAuthConfig = config({
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      endpointUrl: "http://localhost:11434/v1",
      registryInferenceRoute: {
        ...config().registryInferenceRoute!,
        endpointUrl: "http://localhost:11434/v1",
      },
    });

    await expect(
      checkRebuildGatewayCredentialReuseOrBail(
        "alpha",
        noAuthConfig,
        false,
        vi.fn(),
        throwingBail,
        {
          readGatewayProviderMetadata: async () => noAuthGatewayProvider,
          readRecordedProviderEndpoints: () => [],
        },
      ),
    ).resolves.toBe(true);
  });

  it("preserves normal host-key validation without reading gateway recovery metadata", async () => {
    const readGatewayProviderMetadata = vi.fn();
    await expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), true, vi.fn(), throwingBail, {
        readGatewayProviderMetadata,
        readRecordedProviderEndpoints: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(readGatewayProviderMetadata).not.toHaveBeenCalled();
  });

  it("preserves Bedrock Runtime rebuilds with explicit AWS authentication", async () => {
    const readGatewayProviderMetadata = vi.fn();
    const bedrock = config({
      provider: "compatible-anthropic-endpoint",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      registryInferenceRoute: {
        provider: "compatible-anthropic-endpoint",
        model: "nvidia/model",
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        preferredInferenceApi: "openai-completions",
        source: "registry",
      },
    });

    await expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", bedrock, false, vi.fn(), throwingBail, {
        hasBedrockRuntimeAwsAuth: () => true,
        readGatewayProviderMetadata,
        readRecordedProviderEndpoints: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(readGatewayProviderMetadata).not.toHaveBeenCalled();
  });

  it("rejects Bedrock Runtime before deletion when neither AWS nor compatible auth exists", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bedrock = config({
      provider: "compatible-anthropic-endpoint",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      registryInferenceRoute: {
        provider: "compatible-anthropic-endpoint",
        model: "nvidia/model",
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        preferredInferenceApi: "openai-completions",
        source: "registry",
      },
    });

    await expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", bedrock, false, vi.fn(), throwingBail, {
        hasBedrockRuntimeAwsAuth: () => false,
        readGatewayProviderMetadata: async () => ({
          name: "compatible-anthropic-endpoint",
          type: "openai",
          credentialKeys: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
          configKeys: ["OPENAI_BASE_URL"],
        }),
        readRecordedProviderEndpoints: () => [],
      }),
    ).rejects.toThrow("Missing Bedrock Runtime authentication");

    const diagnostics = errors.mock.calls.flat().join(" ");
    expect(diagnostics).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(diagnostics).toContain("AWS_PROFILE");
    expect(diagnostics).toContain("IAM environment credentials");
    expect(diagnostics).toContain("COMPATIBLE_ANTHROPIC_API_KEY");
  });

  it.each([
    ["missing registry route", config({ registryInferenceRoute: null })],
    [
      "oversized model",
      config({
        model: "m".repeat(513),
        registryInferenceRoute: {
          ...config().registryInferenceRoute!,
          model: "m".repeat(513),
        },
      }),
    ],
    [
      "oversized endpoint",
      config({
        endpointUrl: `https://example.test/${"x".repeat(2049)}`,
        registryInferenceRoute: {
          ...config().registryInferenceRoute!,
          endpointUrl: `https://example.test/${"x".repeat(2049)}`,
        },
      }),
    ],
  ])("rejects %s before destructive rebuild work", async (_label, unsafeConfig) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      checkRebuildGatewayCredentialReuseOrBail(
        "alpha",
        unsafeConfig,
        false,
        vi.fn(),
        throwingBail,
        {
          readGatewayProviderMetadata: async () => exactGatewayProvider,
          readRecordedProviderEndpoints: () => [],
        },
      ),
    ).rejects.toThrow("Unsafe gateway credential reuse");
  });

  it("rejects spoofed gateway bindings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spoofedProvider = {
      ...exactGatewayProvider,
      credentialKeys: ["ATTACKER_KEY"],
    };
    await expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), false, vi.fn(), throwingBail, {
        readGatewayProviderMetadata: async () => spoofedProvider,
        readRecordedProviderEndpoints: () => [],
      }),
    ).rejects.toThrow("Unsafe gateway credential reuse");
    const diagnostics = error.mock.calls.flat().join("\n");
    expect(diagnostics).not.toContain("compatible-endpoint");
    expect(diagnostics).not.toContain("COMPATIBLE_API_KEY");
    expect(diagnostics).not.toContain("ATTACKER_KEY");
  });

  it("rejects a custom endpoint recorded by another sandbox", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readRecordedProviderEndpoints = vi.fn(() => ["https://other.example.test/v1"]);

    await expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", config(), false, vi.fn(), throwingBail, {
        readGatewayProviderMetadata: async () => exactGatewayProvider,
        readRecordedProviderEndpoints,
      }),
    ).rejects.toThrow("Unsafe gateway credential reuse");
    expect(readRecordedProviderEndpoints).toHaveBeenCalledWith("compatible-endpoint", "alpha");
  });

  it("reports the rejected recovery condition without endpoint details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mismatchedEndpoint = config({
      endpointUrl: "https://secret-canary.example.test/v1",
    });

    await expect(
      checkRebuildGatewayCredentialReuseOrBail(
        "alpha",
        mismatchedEndpoint,
        false,
        vi.fn(),
        throwingBail,
        {
          readGatewayProviderMetadata: async () => exactGatewayProvider,
          readRecordedProviderEndpoints: () => [],
        },
      ),
    ).rejects.toThrow("Unsafe gateway credential reuse");

    const diagnostics = error.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("The recorded endpoint identity is missing or incompatible.");
    expect(diagnostics).not.toContain("secret-canary");
  });
});

describe("hosted native rebuild provider preflight", () => {
  it.each([
    ...HOSTED_NATIVE_PROVIDERS,
    hostedNativeProvider("hermes-provider", "https://staging.nous.example/v1")!,
  ])(
    "verifies $providerName instead of the legacy provider before deletion",
    async (definition) => {
      const adapter = createCliOpenShellProviderAdapter();
      const receipt = {
        schemaVersion: 1 as const,
        profileId: definition.profileId,
        providerName: definition.providerName,
        providerId: "owned-id",
        ...("endpointUrl" in definition
          ? { endpointUrl: definition.endpointUrl, allowedIps: ["8.8.8.8"] }
          : {}),
      };
      const get = vi.spyOn(adapter, "getProvider").mockResolvedValue({
        ok: true,
        value: {
          name: definition.providerName,
          type: definition.profileId,
          credentialKeys: [definition.credentialEnv],
          configKeys: [],
          credentialExpiresAtMs: {},
          revision: { id: "owned-id", resourceVersion: 1 },
        },
      });
      await expect(
        inspectRebuildGatewayProviderRegistration(
          definition.logicalProvider,
          vi.fn(),
          "Preflight",
          undefined,
          adapter,
          definition.credentialEnv,
          receipt,
        ),
      ).resolves.toBe("registered");
      expect(get).toHaveBeenCalledWith(
        expect.objectContaining({ providerName: definition.providerName }),
      );
      await expect(
        inspectRebuildGatewayProviderRegistration(
          definition.logicalProvider,
          vi.fn(),
          "Preflight",
          undefined,
          adapter,
          definition.credentialEnv,
          { ...receipt, providerId: "different-id" },
        ),
      ).resolves.toBe("indeterminate");
    },
  );
});

it.each(["valid", "replaced", "detached", "selection-changed"] as const)(
  "checks the external binding at the destructive rebuild boundary: %s",
  async (state) => {
    const f = registeredInferenceFixture(state !== "detached");
    f.state.id = state === "replaced" ? "replacement" : f.state.id;
    vi.spyOn(managedProviderAdapter, "createManagedProviderAdapter").mockReturnValue(f.adapter);
    const resume = config({
      agent: "openclaw",
      provider: f.binding.providerName,
      model: "model-a",
      endpointUrl: f.binding.endpointUrl,
      credentialEnv: f.binding.credentialEnv,
      preferredInferenceApi: f.binding.inferenceApi,
      registeredInferenceProviderAttachment: f.binding,
    });
    const entry = {
      ...resume,
      name: f.binding.sandboxName,
      gatewayName: f.binding.gatewayName,
      model: state === "selection-changed" ? "other-model" : resume.model,
    };
    expect(
      await verifyRebuildRegisteredProviderBeforeDelete(
        f.binding.sandboxName,
        f.binding.gatewayName,
        resume,
        undefined,
        () => entry,
      ),
    ).toBe(state === "valid");
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
  },
);
