// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createProviders } from "./providers";
import { createSandboxes } from "./sandboxes";
import { createSandboxConfig } from "./sandbox-config";
import type { OpenShellReadClient } from "./sdk-read";

const canary = "secret-response-canary";
const target = { kind: "named", gatewayName: "nemoclaw-9443" } as const;
const request = () => ({
  target,
  workspace: "default",
  name: "alpha",
  configKeys: ["OPENAI_BASE_URL"],
  signal: new AbortController().signal,
});
const metadata = () => ({
  id: "resource-id",
  name: "alpha",
  workspace: "default",
  resourceVersion: 18446744073709551615n,
});
const provider = () => ({
  provider: {
    metadata: metadata(),
    type: "openai",
    credentials: { API_KEY: canary },
    credentialHandles: { TOKEN: canary },
    config: { OPENAI_BASE_URL: "https://api.example/v1", UNUSED: canary },
  },
});
function fixture() {
  const raw = {
    getProviderProfile: vi.fn(),
    getProvider: vi.fn().mockResolvedValue(provider()),
    getSandbox: vi.fn().mockResolvedValue({
      sandbox: {
        metadata: metadata(),
        spec: {
          template: {
            image: "registry/image@sha256:" + "a".repeat(64),
            environment: { TOKEN: canary },
          },
          providers: ["inference"],
          environment: { TOKEN: canary },
        },
        status: { currentPolicyVersion: 3 },
      },
    }),
    getSandboxConfig: vi.fn().mockResolvedValue({
      workspace: "default",
      version: 3,
      policyHash: "a".repeat(64),
      configRevision: 18446744073709551615n,
      providerEnvRevision: 9007199254740993n,
      policySource: 1,
      globalPolicyVersion: 0,
      settings: { TOKEN: canary },
      policy: { TOKEN: canary },
    }),
  } satisfies OpenShellReadClient["raw"];
  const connect = vi.fn(async () => ({ raw }));
  return { raw, connect };
}

function nativeNvidiaFixture() {
  const fixtureValue = fixture();
  const profile = {
    id: "nvidia",
    source: "builtin",
    scope: "",
    resourceVersion: 0n,
    inferenceCapable: true,
    endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }],
  };
  fixtureValue.raw.getProvider.mockResolvedValue({
    provider: {
      ...provider().provider,
      type: "nvidia",
      profileWorkspace: "",
      config: {},
    },
  });
  fixtureValue.raw.getProviderProfile.mockResolvedValue({ profile });
  return { ...fixtureValue, profile };
}

describe("OpenShell provider evidence", () => {
  it("returns requested config values and credential names without secret material", async () => {
    const { connect, raw } = fixture();
    const input = request();
    const result = await createProviders(connect).get(input);
    expect(result).toEqual({
      id: "resource-id",
      name: "alpha",
      workspace: "default",
      type: "openai",
      resourceVersion: "18446744073709551615",
      credentialKeys: ["API_KEY", "TOKEN"],
      configKeys: ["OPENAI_BASE_URL", "UNUSED"],
      config: { OPENAI_BASE_URL: "https://api.example/v1" },
    });
    expect(raw.getProvider).toHaveBeenCalledWith(
      { name: "alpha", workspace: "default" },
      { signal: input.signal },
    );
    expect(connect).toHaveBeenCalledWith(target);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(Object.isFrozen(result?.config)).toBe(true);
    const response = await raw.getProvider.mock.results[0]!.value;
    response.provider.config.OPENAI_BASE_URL = "https://changed.example";
    expect(result?.config.OPENAI_BASE_URL).toBe("https://api.example/v1");
  });

  it("verifies the native NVIDIA endpoint through the named gateway profile", async () => {
    const { connect, raw } = nativeNvidiaFixture();
    const input = request();
    const result = await createProviders(connect).get(input);
    expect(result).toMatchObject({
      type: "nvidia",
      configKeys: [],
      config: {},
      builtinInferenceEndpoint: "https://integrate.api.nvidia.com/v1",
    });
    expect(raw.getProviderProfile).toHaveBeenCalledWith(
      { id: "nvidia", workspace: "default" },
      { signal: input.signal },
    );
    expect(connect).toHaveBeenCalledExactlyOnceWith(target);
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each([
    { label: "wrong identity", change: { id: "openai" } },
    { label: "custom source", change: { source: "user" } },
    { label: "interceptor source", change: { source: "interceptor/custom" } },
    { label: "workspace scope", change: { scope: "workspace" } },
    { label: "custom revision", change: { resourceVersion: 1n } },
    { label: "missing revision", change: { resourceVersion: undefined } },
    { label: "disabled inference", change: { inferenceCapable: false } },
    { label: "missing endpoint", change: { endpoints: [] } },
    { label: "changed host", change: { endpoints: [{ host: "different.example", port: 443 }] } },
    {
      label: "changed port",
      change: { endpoints: [{ host: "integrate.api.nvidia.com", port: 80 }] },
    },
    {
      label: "multiple endpoints",
      change: {
        endpoints: [
          { host: "integrate.api.nvidia.com", port: 443 },
          { host: "different.example", port: 443 },
        ],
      },
    },
  ])("rejects NVIDIA profile evidence with $label", async ({ change }) => {
    const { connect, raw, profile } = nativeNvidiaFixture();
    raw.getProviderProfile.mockResolvedValue({ profile: { ...profile, ...change } });
    await expect(createProviders(connect).get(request())).rejects.toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
  });

  it.each([
    { profileWorkspace: "default", config: {} },
    { profileWorkspace: undefined, config: {} },
    { profileWorkspace: "", config: { NVIDIA_BASE_URL: "https://different.example/v1" } },
    { profileWorkspace: "", config: { UNUSED: canary } },
  ])("does not infer a builtin endpoint for NVIDIA overrides %#", async (change) => {
    const { connect, raw } = nativeNvidiaFixture();
    raw.getProvider.mockResolvedValue({
      provider: { ...provider().provider, type: "nvidia", ...change },
    });
    const result = await createProviders(connect).get(request());
    expect(result).not.toHaveProperty("builtinInferenceEndpoint");
    expect(raw.getProviderProfile).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each([
    { code: 5, kind: "transport" },
    { code: 7, kind: "authentication" },
    { code: 4, kind: "timeout" },
    { code: 14, kind: "transport" },
  ])("stops when NVIDIA profile verification fails with status $code", async ({ code, kind }) => {
    const { connect, raw } = nativeNvidiaFixture();
    raw.getProviderProfile.mockRejectedValue({ code, message: canary });
    await expect(createProviders(connect).get(request())).rejects.toMatchObject({
      kind,
      message: `OpenShell read failed (${kind}).`,
    });
    expect(raw.getProvider).toHaveBeenCalledTimes(1);
    expect(raw.getProviderProfile).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "empty text", value: "" },
    { name: "control character", value: "openai\n" },
    { name: "format character", value: "openai\u200b" },
    { name: "oversized ASCII", value: "a".repeat(4097) },
    { name: "oversized UTF-16", value: "😀".repeat(2049) },
  ])("rejects $name without exposing the response", async ({ value }) => {
    const { connect, raw } = fixture();
    raw.getProvider.mockResolvedValue({ provider: { ...provider().provider, type: value } });
    await expect(createProviders(connect).get(request())).rejects.toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
  });

  it("accepts bounded Unicode text and leaves unrequested values opaque", async () => {
    const { connect, raw } = fixture();
    const response = provider();
    const type = "😀".repeat(2048);
    raw.getProvider.mockResolvedValue({
      provider: {
        ...response.provider,
        type,
        credentials: { API_KEY: { secret: canary } },
        credentialHandles: null,
        config: { ...response.provider.config, UNUSED: { secret: canary } },
      },
    });
    const result = await createProviders(connect).get(request());
    expect(result).toMatchObject({ type, credentialKeys: ["API_KEY"] });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each(["0", "18446744073709551615", 0n])(
    "preserves a supported resource revision %s",
    async (resourceVersion) => {
      const { connect, raw } = fixture();
      raw.getProvider.mockResolvedValue({
        provider: { ...provider().provider, metadata: { ...metadata(), resourceVersion } },
      });
      await expect(createProviders(connect).get(request())).resolves.toMatchObject({
        resourceVersion: String(resourceVersion),
      });
    },
  );

  it.each(["18446744073709551616", 18446744073709551616n, -1n, "01", "1\n", "no-version"])(
    "rejects an invalid resource revision %s",
    async (resourceVersion) => {
      const { connect, raw } = fixture();
      raw.getProvider.mockResolvedValue({
        provider: { ...provider().provider, metadata: { ...metadata(), resourceVersion } },
      });
      await expect(createProviders(connect).get(request())).rejects.toMatchObject({
        kind: "schema",
      });
    },
  );

  it.each([
    { credentials: [] },
    { config: null },
    { credentialHandles: [] },
    { config: { OPENAI_BASE_URL: { secret: canary } } },
    { credentials: { ["BAD\nKEY"]: canary } },
  ])("rejects malformed consumed provider fields %#", async (change) => {
    const { connect, raw } = fixture();
    raw.getProvider.mockResolvedValue({ provider: { ...provider().provider, ...change } });
    await expect(createProviders(connect).get(request())).rejects.toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
  });

  it("returns null only for a confirmed missing provider", async () => {
    const { connect, raw } = fixture();
    raw.getProvider.mockRejectedValue({ code: 5, message: canary });
    await expect(createProviders(connect).get(request())).resolves.toBeNull();
  });

  it.each([
    { code: 7, kind: "authentication" },
    { code: 16, kind: "authentication" },
    { code: 4, kind: "timeout" },
    { code: 14, kind: "transport" },
  ])("reports a sanitized $kind failure for status $code", async ({ code, kind }) => {
    const { connect, raw } = fixture();
    raw.getProvider.mockRejectedValue({ code, message: canary });
    const error = await createProviders(connect)
      .get(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind, message: `OpenShell read failed (${kind}).` });
    expect(String(error)).not.toContain(canary);
    expect(raw.getProvider).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "workspace", metadata: { ...metadata(), workspace: "other" } },
    { label: "name", metadata: { ...metadata(), name: "other" } },
    { label: "revision", metadata: { ...metadata(), resourceVersion: 9007199254740992 } },
  ])("rejects a wrong $label", async ({ metadata: meta }) => {
    const { connect, raw } = fixture();
    raw.getProvider.mockResolvedValue({ provider: { ...provider().provider, metadata: meta } });
    await expect(createProviders(connect).get(request())).rejects.toMatchObject({ kind: "schema" });
  });

  it("rejects an absent provider envelope without treating it as not found", async () => {
    const { connect, raw } = fixture();
    raw.getProvider.mockResolvedValue({});
    await expect(createProviders(connect).get(request())).rejects.toMatchObject({ kind: "schema" });
  });

  it("cancels a pending read even if the transport ignores cancellation", async () => {
    const { connect, raw } = fixture();
    const controller = new AbortController();
    raw.getProvider.mockImplementation(async () => {
      controller.abort(canary);
      return new Promise(() => {});
    });
    await expect(
      createProviders(connect).get({ ...request(), signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(raw.getProvider).toHaveBeenCalledTimes(1);
  });

  it("does not start a request after cancellation", async () => {
    const { connect } = fixture();
    await expect(
      createProviders(connect).get({ ...request(), signal: AbortSignal.abort(canary) }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires an explicit gateway before a connection", async () => {
    const { connect } = fixture();
    await expect(
      createProviders(connect).get({ ...request(), target: { kind: "selected" } }),
    ).rejects.toMatchObject({ kind: "schema" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("OpenShell sandbox export evidence", () => {
  it("projects image and identity without environment values", async () => {
    const { connect, raw } = fixture();
    const input = request();
    const result = await createSandboxes(connect).get(input);
    expect(result).toMatchObject({
      id: "resource-id",
      workspace: "default",
      resourceVersion: "18446744073709551615",
      policyVersion: 3,
      providers: ["inference"],
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(raw.getSandbox).toHaveBeenCalledWith(
      { name: "alpha", workspace: "default" },
      { signal: input.signal },
    );
  });

  it.each([
    { spec: { template: { image: "image" }, providers: "provider" } },
    { spec: { template: { image: "image" }, providers: [42] } },
    { spec: { template: [], providers: [] } },
    { status: { currentPolicyVersion: Number.MAX_SAFE_INTEGER + 1 } },
    { status: { currentPolicyVersion: -1 } },
  ])("rejects malformed sandbox evidence %#", async (change) => {
    const { connect, raw } = fixture();
    const response = await raw.getSandbox();
    raw.getSandbox.mockResolvedValue({ sandbox: { ...response.sandbox, ...change } });
    await expect(createSandboxes(connect).get(request())).rejects.toMatchObject({ kind: "schema" });
  });

  it("distinguishes a missing sandbox from a failed read", async () => {
    const { connect, raw } = fixture();
    raw.getSandbox
      .mockRejectedValueOnce({ code: 5 })
      .mockRejectedValueOnce({ code: 14, message: canary });
    await expect(createSandboxes(connect).get(request())).resolves.toBeNull();
    await expect(createSandboxes(connect).get(request())).rejects.toMatchObject({
      kind: "transport",
    });
  });

  it.each([1, 2])(
    "reads source %i configuration by verified ID without settings values",
    async (policySource) => {
      const { connect, raw } = fixture();
      const input = { ...request(), sandboxId: "verified-id" };
      const response = await raw.getSandboxConfig();
      raw.getSandboxConfig.mockClear().mockResolvedValue({
        ...response,
        policySource,
        globalPolicyVersion: policySource === 2 ? 4 : 0,
      });
      const result = await createSandboxConfig(connect, async () => "version: 1\n").get(input);
      expect(result).toMatchObject({
        sandboxId: "verified-id",
        workspace: "default",
        revision: 3,
        configRevision: "18446744073709551615",
        providerEnvRevision: "9007199254740993",
        policySource: policySource === 1 ? "sandbox" : "global",
        policy: { document: "version: 1\n", appliedRevision: policySource === 1 ? 3 : 4 },
      });
      expect(raw.getSandboxConfig).toHaveBeenCalledWith(
        { sandboxId: "verified-id" },
        { signal: input.signal },
      );
      expect(JSON.stringify(result)).not.toContain(canary);
    },
  );

  it("does not serialize a configuration response that arrives after abort", async () => {
    const { connect, raw } = fixture();
    const response = await raw.getSandboxConfig();
    const controller = new AbortController();
    raw.getSandboxConfig.mockImplementation(async () => {
      controller.abort();
      return response;
    });
    const serialize = vi.fn(async () => "version: 1\n");
    await expect(
      createSandboxConfig(connect, serialize).get({
        ...request(),
        sandboxId: "verified-id",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(serialize).not.toHaveBeenCalled();
  });

  it.each([
    { workspace: "other" },
    { policySource: 0 },
    { policySource: 99 },
    { configRevision: -1n },
    { version: 1.5 },
    { policyHash: "" },
  ])("rejects inconclusive configuration metadata %#", async (change) => {
    const { connect, raw } = fixture();
    const response = await raw.getSandboxConfig();
    raw.getSandboxConfig.mockResolvedValue({ ...response, ...change });
    await expect(
      createSandboxConfig(connect).get({ ...request(), sandboxId: "verified-id" }),
    ).rejects.toMatchObject({ kind: "schema" });
  });
});
