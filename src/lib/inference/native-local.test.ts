// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { OLLAMA_PROXY_PORT } from "../core/ollama-proxy-port";
import { isProtectedLocalInferencePort } from "./gateway/local-endpoint-ports";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import {
  nativeLocalIdentity,
  nativeLocalCredentialReference,
  normalizeNativeLocalBinding,
  normalizeNativeLocalProviderAttachment,
  usesNativeLocalInferenceForAgent,
  type NativeLocalBinding,
  type NativeLocalProviderAttachment,
} from "./native-local/contract";
import {
  ensureNativeLocalProvider,
  ensureNativeLocalProviderAttached,
  prepareNativeLocalProfile,
  verifyNativeLocalProviderAttachment,
  verifyRecordedNativeLocalProviderAttachment,
  retireNativeLocalProvider,
} from "./native-local/profile";

vi.mock("../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

const binding: NativeLocalBinding = {
  provider: "ollama-local",
  endpointUrl: "http://host.openshell.internal:11435/v1",
  credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
  authMode: "authenticated",
  gatewayName: "nemoclaw",
  sandboxName: "alice",
};
const identity = nativeLocalIdentity(binding);
const receipt: NativeLocalProviderAttachment = {
  ...binding,
  ...identity,
  schemaVersion: 1,
  providerId: "owned-id",
};

function fixture(selectedBinding: NativeLocalBinding = binding) {
  const binding = selectedBinding;
  const identity = nativeLocalIdentity(binding);
  let present = false;
  let attached = false;
  let authority: NativeLocalProviderAttachment | undefined;
  const adapter = {
    ensureProviderPolicyComposition: vi.fn(() => {
      throw new Error("Native local setup must not activate provider composition");
    }),
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(async () => ({
      ok: true,
    })),
    inspectProviderProfile: vi.fn<OpenShellProviderAdapter["inspectProviderProfile"]>(async () => ({
      ok: true,
      value: { credentialKeys: [binding.credentialEnv] },
    })),
    getProvider: vi.fn(async () =>
      present
        ? {
            ok: true as const,
            value: {
              name: identity.providerName,
              type: identity.profileId,
              credentialKeys: [binding.credentialEnv],
              configKeys: [],
              revision: { id: "owned-id", resourceVersion: 1 },
            },
          }
        : {
            ok: false as const,
            error: {
              kind: "command" as const,
              reason: "not_found" as const,
              message: "absent",
            },
          },
    ),
    createProvider: vi.fn(async () => {
      present = true;
      return { ok: true as const };
    }),
    updateProvider: vi.fn(async () => ({ ok: true as const })),
    deleteProvider: vi.fn(async () => {
      present = false;
      return { ok: true as const };
    }),
    listProviderAttachments: vi.fn(async () => ({
      ok: true as const,
      value: { names: attached ? [identity.providerName] : [] },
    })),
    attachProvider: vi.fn(async () => {
      attached = true;
      return { ok: true as const };
    }),
    detachProvider: vi.fn(async () => {
      attached = false;
      return { ok: true as const, value: { changed: true } };
    }),
    listProviders: vi.fn(),
    configureProviderRefresh: vi.fn(),
    getProviderRefreshStatus: vi.fn(),
  } satisfies OpenShellProviderAdapter;
  return {
    adapter,
    input: {
      adapter,
      binding,
      credentialValue: "test-only-secret",
      readAuthority: () => authority,
      writeAuthority: (value: NativeLocalProviderAttachment) => {
        authority = value;
      },
    },
  };
}

describe("native local inference", () => {
  it.each([
    { reason: "wrong agent", override: { agent: "hermes" } },
    { reason: "wrong provider", override: { provider: "compatible-endpoint" } },
    { reason: "wrong sandbox", override: { sandboxName: "bob" } },
    { reason: "wrong gateway", override: { gatewayName: "nemoclaw-8081" } },
    { reason: "malformed receipt", override: { expected: {} } },
  ])(
    "stops a native rebuild with $reason before provider access (#13197)",
    async ({ override }) => {
      const f = fixture();
      await expect(
        verifyRecordedNativeLocalProviderAttachment({
          adapter: f.adapter,
          expected: receipt,
          agent: "langchain-deepagents-code",
          sandboxName: binding.sandboxName,
          gatewayName: binding.gatewayName,
          provider: binding.provider,
          ...override,
        }),
      ).rejects.toThrow("does not match the rebuild target");
      expect(f.adapter.inspectProviderProfile).not.toHaveBeenCalled();
      expect(f.adapter.getProvider).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      state: "missing",
      change: (f: ReturnType<typeof fixture>, _expected: NativeLocalProviderAttachment) =>
        f.adapter.deleteProvider(),
    },
    {
      state: "changed instance",
      change: (f: ReturnType<typeof fixture>, expected: NativeLocalProviderAttachment) => {
        f.adapter.getProvider.mockResolvedValue({
          ok: true,
          value: {
            name: expected.providerName,
            type: expected.profileId,
            credentialKeys: [expected.credentialEnv],
            configKeys: [],
            revision: { id: "different-instance", resourceVersion: 2 },
          },
        });
      },
    },
    {
      state: "detached",
      change: (f: ReturnType<typeof fixture>, _expected: NativeLocalProviderAttachment) =>
        f.adapter.detachProvider(),
    },
    {
      state: "profile mismatch",
      change: (f: ReturnType<typeof fixture>, _expected: NativeLocalProviderAttachment) => {
        f.adapter.inspectProviderProfile.mockResolvedValue({
          ok: false,
          error: { kind: "parse", message: "mismatched" },
        } as never);
      },
    },
    {
      state: "unavailable",
      change: (f: ReturnType<typeof fixture>, _expected: NativeLocalProviderAttachment) => {
        f.adapter.getProvider.mockRejectedValue(new Error("transport unavailable"));
      },
    },
  ])("stops a native rebuild when recorded access is $state (#13197)", async ({ change }) => {
    const f = fixture();
    const expected = await ensureNativeLocalProvider(f.input);
    await ensureNativeLocalProviderAttached({ adapter: f.adapter, expected, sandboxName: "alice" });
    await change(f, expected);
    vi.clearAllMocks();
    await expect(
      verifyRecordedNativeLocalProviderAttachment({
        adapter: f.adapter,
        expected,
        agent: "langchain-deepagents-code",
        sandboxName: "alice",
        gatewayName: "nemoclaw",
        provider: binding.provider,
      }),
    ).rejects.toThrow();
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  });

  it.each([
    "http://host.openshell.internal:11435/v1",
    "http://host.docker.internal:11435/v1/",
    "http://10.1.2.3:8000/v1",
  ])("issues a local credential reference for a qualified endpoint: %s", (endpointUrl) => {
    expect(normalizeNativeLocalBinding({ ...binding, endpointUrl })).toBeDefined();
    expect(nativeLocalCredentialReference("ollama-local", endpointUrl)).toBe(
      "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    );
    expect(nativeLocalCredentialReference("openai-api", endpointUrl)).toBeNull();
  });

  it.each([
    "http://host.openshell.internal/v1",
    "http://host.openshell.internal:80/v1",
    "http://host.openshell.internal:11435/v1?key=hidden",
    "http://host.openshell.internal:11435/v1#fragment",
    "http://host.openshell.internal:11435/v1/**",
    "http://host.openshell.internal:11435/v1%2fadmin",
    "http://127.0.0.1:11435/v1",
    "http://169.254.169.254:11435/v1",
  ])("rejects an unqualified local credential endpoint: %s", (endpointUrl) => {
    expect(normalizeNativeLocalBinding({ ...binding, endpointUrl })).toBeUndefined();
    expect(nativeLocalCredentialReference("ollama-local", endpointUrl)).toBeNull();
  });

  it.each([
    ["openclaw", true],
    ["langchain-deepagents-code", true],
    ["pi", false],
    ["hermes", false],
  ])("selects native local routing only for migrated %s", (agent, expected) => {
    expect(usesNativeLocalInferenceForAgent(agent, binding.provider, binding.endpointUrl)).toBe(
      expected,
    );
  });

  it("keeps an owned Local NIM selection on the shared route while standalone vLLM is native", () => {
    expect(usesNativeLocalInferenceForAgent("openclaw", "vllm-local", null)).toBe(true);
    expect(usesNativeLocalInferenceForAgent("langchain-deepagents-code", "vllm-local", null)).toBe(
      true,
    );
    expect(usesNativeLocalInferenceForAgent("openclaw", "vllm-local", null, true)).toBe(false);
    expect(
      usesNativeLocalInferenceForAgent("langchain-deepagents-code", "vllm-local", null, true),
    ).toBe(false);
    expect(
      usesNativeLocalInferenceForAgent("langchain-deepagents-code", "llama-cpp-local", null, true),
    ).toBe(true);
  });

  it("restricts the selected bridge to models and chat requests (#12558)", () => {
    const profile = prepareNativeLocalProfile(binding);
    expect(profile.document.binaries).toContain("/usr/bin/python3");
    expect(profile.document.binaries).not.toContain("/usr/local/bin/node");
    const openClawProfile = prepareNativeLocalProfile({ ...binding, agent: "openclaw" });
    expect(openClawProfile.document.binaries).toContain("/usr/local/bin/node");
    expect(openClawProfile.document.binaries).not.toContain("/usr/bin/python3");
    expect(openClawProfile.profileId).not.toBe(profile.profileId);
    expect(profile.document.binaries).not.toContain("/usr/local/bin/openclaw");
    expect(profile.document.binaries).not.toContain("/opt/hermes/.venv/bin/python");
    expect(profile.document.endpoints).toEqual([
      {
        host: "host.openshell.internal",
        port: 11435,
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
        rules: [
          { allow: { method: "GET", path: "/v1/models" } },
          { allow: { method: "POST", path: "/v1/chat/completions" } },
        ],
      },
    ]);
    expect(profile.document.binaries.every((path) => !/[?*]/.test(path))).toBe(true);
  });
  it("separates authentication modes and sandbox instances without credential-derived names (#12558)", () => {
    const sentinel = nativeLocalIdentity({ ...binding, authMode: "sentinel" });
    const otherSandbox = nativeLocalIdentity({
      ...binding,
      sandboxName: "bob",
    });
    expect(sentinel.profileId).not.toBe(identity.profileId);
    expect(otherSandbox.profileId).toBe(identity.profileId);
    expect(otherSandbox.providerName).not.toBe(identity.providerName);
  });
  it("keeps runtime publication transactions distinct without changing endpoint permissions (#12558)", () => {
    const first = nativeLocalIdentity({
      ...binding,
      transactionId: "a".repeat(64),
    });
    const second = nativeLocalIdentity({
      ...binding,
      transactionId: "b".repeat(64),
    });
    expect(first.profileId).toBe(second.profileId);
    expect(first.providerName).not.toBe(second.providerName);
  });
  it.each([
    "http://127.0.0.1:11434/v1",
    "http://localhost:11434/v1",
    "http://host.openshell.internal:11434/v1?token=private",
    "http://user:private@host.openshell.internal:11434/v1",
    "http://169.254.169.254:8080/v1",
    "http://unqualified.example:11434/v1",
    "http://host.openshell.internal:11434/v1/**",
    "http://host.openshell.internal:11434/v1%2fadmin",
  ])(
    "rejects an unqualified endpoint before a provider mutation: %s (#12558)",
    async (endpointUrl) => {
      const f = fixture();
      await expect(
        ensureNativeLocalProvider({
          ...f.input,
          binding: { ...binding, endpointUrl },
        }),
      ).rejects.toThrow("boundary");
      expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
      expect(f.adapter.createProvider).not.toHaveBeenCalled();
    },
  );
  it("persists only endpoint identity and removes its temporary profile (#12558)", async () => {
    const f = fixture();
    let temporaryPath = "";
    f.adapter.importProviderProfile.mockImplementation(async (input) => {
      temporaryPath = input.profilePath;
      expect(fs.readFileSync(temporaryPath, "utf8")).not.toContain(f.input.credentialValue);
      return { ok: true };
    });
    const actual = await ensureNativeLocalProvider(f.input);
    expect(actual).toEqual(receipt);
    expect(f.input.readAuthority()).toEqual(receipt);
    expect(JSON.stringify(actual)).not.toContain(f.input.credentialValue);
    expect(fs.existsSync(temporaryPath)).toBe(false);
  });
  it("preserves an existing sentinel instead of reading a host OpenAI key (#12558)", async () => {
    const f = fixture({ ...binding, authMode: "sentinel" });
    await ensureNativeLocalProvider({ ...f.input, credentialValue: "ollama" });
    expect(f.adapter.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: [{ name: binding.credentialEnv, value: "ollama" }],
        config: [],
      }),
    );
  });
  it("refuses a profile collision before changing provider state (#12558)", async () => {
    const f = fixture();
    f.adapter.importProviderProfile.mockResolvedValue({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message: "collision",
      },
    } as never);
    await expect(ensureNativeLocalProvider(f.input)).rejects.toThrow("conflicts");
    expect(f.adapter.getProvider).not.toHaveBeenCalled();
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
  });
  it("observes an ambiguous creation before recording ownership (#12558)", async () => {
    const f = fixture();
    const create = f.adapter.createProvider.getMockImplementation()!;
    f.adapter.createProvider.mockImplementation(async () => {
      await create();
      return {
        ok: false,
        error: { kind: "timeout", message: "lost response" },
      } as never;
    });
    expect(await ensureNativeLocalProvider(f.input)).toEqual(receipt);
    expect(f.adapter.createProvider).toHaveBeenCalledTimes(1);
    expect(f.adapter.getProvider).toHaveBeenCalledTimes(2);
  });
  it("removes only the new provider when ownership cannot be saved (#12558)", async () => {
    const f = fixture();
    await expect(
      ensureNativeLocalProvider({
        ...f.input,
        writeAuthority: () => {
          throw new Error("cannot save");
        },
      }),
    ).rejects.toThrow("newly created provider was removed");
    expect(f.adapter.deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: binding.gatewayName },
      providerName: identity.providerName,
    });
  });
  it("attaches only to its recorded sandbox and verifies the applied name (#12558)", async () => {
    const f = fixture();
    const expected = await ensureNativeLocalProvider(f.input);
    await expect(
      ensureNativeLocalProviderAttached({
        adapter: f.adapter,
        expected,
        sandboxName: "bob",
      }),
    ).rejects.toThrow("selected sandbox");
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    await expect(
      ensureNativeLocalProviderAttached({
        adapter: f.adapter,
        expected,
        sandboxName: "alice",
      }),
    ).resolves.toEqual({ receipt, changed: true });
    await expect(
      verifyNativeLocalProviderAttachment({
        adapter: f.adapter,
        expected,
        sandboxName: "alice",
      }),
    ).resolves.toEqual(receipt);
  });
  it("rejects receipts changed to another endpoint or provider instance (#12558)", () => {
    expect(
      normalizeNativeLocalProviderAttachment({
        ...receipt,
        endpointUrl: "http://host.openshell.internal:8000/v1",
      }),
    ).toBeUndefined();
    expect(
      normalizeNativeLocalProviderAttachment({
        ...receipt,
        sandboxName: "bob",
      }),
    ).toBeUndefined();
  });
  it("refuses another sandbox's attachment before looking up or mutating access (#12558)", async () => {
    const f = fixture();
    await expect(
      ensureNativeLocalProviderAttached({
        adapter: f.adapter,
        sandboxName: "bob",
        expected: receipt,
      }),
    ).rejects.toThrow("selected sandbox");
    expect(f.adapter.getProvider).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });
  it("refuses a changed profile before attachment verification (#12558)", async () => {
    const f = fixture();
    await ensureNativeLocalProvider(f.input);
    f.adapter.inspectProviderProfile.mockResolvedValue({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message: "changed",
      },
    } as never);
    await expect(
      ensureNativeLocalProviderAttached({
        adapter: f.adapter,
        sandboxName: "alice",
        expected: receipt,
      }),
    ).rejects.toThrow("endpoint boundary");
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });
  it("clears cleanup authority only after exact provider removal is confirmed (#12558)", async () => {
    const f = fixture();
    await ensureNativeLocalProvider(f.input);
    const clearAuthority = vi.fn();
    await retireNativeLocalProvider({
      adapter: f.adapter,
      expected: receipt,
      sandboxName: "alice",
      gatewayName: "nemoclaw",
      clearAuthority,
    });
    expect(f.adapter.deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: receipt.providerName,
    });
    expect(clearAuthority).toHaveBeenCalledExactlyOnceWith(receipt);
  });
  it("retains credentials and cleanup authority when another attachment prevents retirement (#12558)", async () => {
    const f = fixture();
    await ensureNativeLocalProvider(f.input);
    f.adapter.deleteProvider.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "attached", message: "still attached" },
    } as never);
    const clearAuthority = vi.fn();
    await expect(
      retireNativeLocalProvider({
        adapter: f.adapter,
        expected: receipt,
        sandboxName: "alice",
        gatewayName: "nemoclaw",
        clearAuthority,
      }),
    ).resolves.toEqual({ status: "attached" });
    expect(clearAuthority).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).toHaveBeenCalledOnce();
  });
  it("retains cleanup authority when removal is ambiguous and the provider still exists (#12558)", async () => {
    const f = fixture();
    await ensureNativeLocalProvider(f.input);
    f.adapter.deleteProvider.mockResolvedValue({
      ok: false,
      error: { kind: "transport", reason: "connection_loss", message: "lost" },
    } as never);
    const clearAuthority = vi.fn();
    await expect(
      retireNativeLocalProvider({
        adapter: f.adapter,
        expected: receipt,
        sandboxName: "alice",
        gatewayName: "nemoclaw",
        clearAuthority,
      }),
    ).rejects.toThrow("not confirmed");
    expect(clearAuthority).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).toHaveBeenCalledTimes(1);
  });
});

vi.mock("../state/gateway-registry", () => ({
  resolveHome: () => "/test-home",
  listRecordedGatewayPorts: () => [12345],
  listRecordedModelRouterPorts: () => [12346],
}));

describe("local inference endpoint port reservations", () => {
  it.each([
    { name: "ordinary backend", port: 11434, options: {}, protected: false },
    { name: "default gateway", port: 8080, options: {}, protected: true },
    { name: "recorded gateway", port: 12345, options: {}, protected: true },
    { name: "retained router", port: 12346, options: {}, protected: true },
    {
      name: "router despite proxy authority",
      port: 12346,
      options: { ownedProxy: true },
      protected: true,
    },
    {
      name: "unowned proxy",
      port: OLLAMA_PROXY_PORT,
      options: {},
      protected: true,
    },
    {
      name: "owned proxy",
      port: OLLAMA_PROXY_PORT,
      options: { ownedProxy: true },
      protected: false,
    },
    {
      name: "gateway despite proxy authority",
      port: 12345,
      options: { ownedProxy: true },
      protected: true,
    },
  ])("protects $name at selection time (#12558)", ({ port, options, protected: expected }) => {
    expect(isProtectedLocalInferencePort(port, options)).toBe(expected);
  });
});

it.each(["http://10.1.2.3:8000/v1", "http://host.openshell.internal:42103/v1"])(
  "keeps compatible endpoint %s on the shared route (#13197)",
  (endpoint) => {
    expect(
      usesNativeLocalInferenceForAgent(
        "langchain-deepagents-code",
        "compatible-endpoint",
        endpoint,
      ),
    ).toBe(false);
  },
);

it("keeps Local NIM and generic compatible endpoints on the shared OpenClaw route", () => {
  expect(
    usesNativeLocalInferenceForAgent("openclaw", "vllm-local", binding.endpointUrl, true),
  ).toBe(false);
  expect(
    usesNativeLocalInferenceForAgent("openclaw", "compatible-endpoint", binding.endpointUrl),
  ).toBe(false);
  expect(usesNativeLocalInferenceForAgent("openclaw", "vllm-local", binding.endpointUrl)).toBe(
    true,
  );
});
