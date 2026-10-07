// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { buildConfig } from "../../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../../../test/helpers/openclaw-env-fixture";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import {
  nativeLocalIdentity,
  normalizeNativeLocalProviderAttachment,
  type NativeLocalBinding,
  type NativeLocalProviderAttachment,
} from "./native-local/contract";
import {
  ensureNativeLocalProvider,
  ensureNativeLocalProviderAttached,
  prepareNativeLocalProfile,
  verifyNativeLocalProviderAttachment,
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
            error: { kind: "command" as const, reason: "not_found" as const, message: "absent" },
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
  it("restricts the selected bridge to models and chat requests (#12558)", () => {
    const profile = prepareNativeLocalProfile(binding);
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
    const otherSandbox = nativeLocalIdentity({ ...binding, sandboxName: "bob" });
    expect(sentinel.profileId).not.toBe(identity.profileId);
    expect(otherSandbox.profileId).toBe(identity.profileId);
    expect(otherSandbox.providerName).not.toBe(identity.providerName);
  });
  it("keeps runtime publication transactions distinct without changing endpoint permissions (#12558)", () => {
    const first = nativeLocalIdentity({ ...binding, transactionId: "a".repeat(64) });
    const second = nativeLocalIdentity({ ...binding, transactionId: "b".repeat(64) });
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
        ensureNativeLocalProvider({ ...f.input, binding: { ...binding, endpointUrl } }),
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
      error: { kind: "command", reason: "profile_incompatible", message: "collision" },
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
      return { ok: false, error: { kind: "timeout", message: "lost response" } } as never;
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
      ensureNativeLocalProviderAttached({ adapter: f.adapter, expected, sandboxName: "bob" }),
    ).rejects.toThrow("selected sandbox");
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    await expect(
      ensureNativeLocalProviderAttached({ adapter: f.adapter, expected, sandboxName: "alice" }),
    ).resolves.toEqual({ receipt, changed: true });
    await expect(
      verifyNativeLocalProviderAttachment({ adapter: f.adapter, expected, sandboxName: "alice" }),
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
      normalizeNativeLocalProviderAttachment({ ...receipt, sandboxName: "bob" }),
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
      error: { kind: "command", reason: "profile_incompatible", message: "changed" },
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

describe("OpenClaw native local inference config", () => {
  it.each(["ollama-local", "vllm-local", "llama-cpp-local"])(
    "writes the selected native endpoint and opaque credential for %s (#12558)",
    (provider) => {
      const environment = {
        ...baseOpenClawGenerationEnv(),
        NEMOCLAW_UPSTREAM_PROVIDER: provider,
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_MODEL: "local-model",
        NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:11434/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        OPENAI_API_KEY: "ambient-secret-must-not-escape",
      };
      const config = buildConfig(environment);
      expect(config.models.providers.inference).toMatchObject({
        baseUrl: "http://host.openshell.internal:11434/v1",
        apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        api: "openai-completions",
        models: [expect.objectContaining({ id: "local-model" })],
      });
      expect(JSON.stringify(config)).not.toContain("ambient-secret-must-not-escape");
    },
  );
});
