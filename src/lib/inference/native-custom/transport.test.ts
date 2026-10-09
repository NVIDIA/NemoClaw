// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import { prepareNativeCustomInference, restoreNativeCustomInference } from "./transport";
import { customAttachmentFromPrepared, normalizeNativeCustomProviderAttachment } from "./index";
import { buildHttpsPinRouteBaseUrl, computeHttpsPinRouteId } from "../https-pin-runtime";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../bedrock-runtime";
import type { ensureHttpsPinRuntimeAdapter } from "../https-pin-runtime-adapter";

afterEach(() => vi.unstubAllEnvs());
const input = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  provider: "compatible-endpoint" as const,
  endpointUrl: "https://api.example.com/v1",
  api: "openai-completions",
  credentialValue: "host-only-secret",
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
};
function httpsAdapter() {
  return vi.fn(async (options: Parameters<typeof ensureHttpsPinRuntimeAdapter>[0]) => {
    const routeId = computeHttpsPinRouteId(
      options.gatewayName,
      options.provider,
      options.endpointUrl,
      options.sandboxName,
    );
    return {
      baseUrl: buildHttpsPinRouteBaseUrl(routeId),
      localBaseUrl: "http://127.0.0.1/route",
      logPath: "/tmp/adapter.log",
      token: "route-only-token",
      credentialEnv: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_TOKEN",
      routeId,
      pinnedAddresses: ["8.8.8.8"],
    };
  });
}
function attachment(
  prepared: Awaited<ReturnType<typeof prepareNativeCustomInference>>["prepared"],
) {
  return customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "owned-provider",
  });
}

it("rejects missing upstream credentials before profile admission or adapter activation (#12636)", async () => {
  const admit = vi.fn(async () => {});
  const ensure = httpsAdapter();
  const lookup = vi.fn(input.lookup);
  await expect(
    prepareNativeCustomInference(
      { ...input, credentialValue: null, lookup },
      {
        admitProfile: admit,
        ensureHttpsAdapter: ensure,
        discoverAllowedSourceCidrs: () => ["172.18.0.0/16"],
      },
    ),
  ).rejects.toThrow("exact recorded native attachment");
  expect(lookup).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
  expect(ensure).not.toHaveBeenCalled();
});

it("admits the native profile before handing upstream credentials to a sandbox-scoped HTTPS route (#12636)", async () => {
  const ensure = httpsAdapter();
  const admit = vi.fn(async () => {
    expect(ensure).not.toHaveBeenCalled();
  });
  const selected = await prepareNativeCustomInference(input, {
    ensureHttpsAdapter: ensure,
    admitProfile: admit,
    discoverAllowedSourceCidrs: () => ["172.18.0.0/16"],
  });
  expect(ensure).toHaveBeenCalledWith(
    expect.objectContaining({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      credentialValue: "host-only-secret",
      providerType: "openai",
    }),
  );
  expect(selected.credentialValue).toBe("route-only-token");
  expect(selected.prepared.profile.endpoints[0]).toMatchObject({
    host: "host.openshell.internal",
    allowed_ips: [],
  });
  const saved = attachment(selected.prepared);
  expect(normalizeNativeCustomProviderAttachment(saved, "alpha")).toEqual(saved);
  expect(JSON.stringify(saved)).not.toMatch(/host-only-secret|route-only-token/);
  expect(saved.transport).toMatchObject({
    kind: "https-pin",
    sourceEndpointUrl: input.endpointUrl,
    sourceAddresses: ["8.8.8.8"],
  });
});

it("isolates HTTPS route custody between sandboxes while preserving legacy route IDs (#12636)", async () => {
  const deps = {
    ensureHttpsAdapter: httpsAdapter(),
    admitProfile: vi.fn(async () => {}),
    discoverAllowedSourceCidrs: () => ["172.18.0.0/16"],
  };
  const alpha = await prepareNativeCustomInference(input, deps);
  const beta = await prepareNativeCustomInference({ ...input, sandboxName: "beta" }, deps);
  expect(alpha.prepared.endpointUrl).not.toBe(beta.prepared.endpointUrl);
  expect(computeHttpsPinRouteId("nemoclaw", input.provider, input.endpointUrl)).not.toBe(
    computeHttpsPinRouteId("nemoclaw", input.provider, input.endpointUrl, "alpha"),
  );
  const saved = attachment(alpha.prepared);
  expect(
    normalizeNativeCustomProviderAttachment({ ...saved, sandboxName: "beta" }),
  ).toBeUndefined();
  expect(
    normalizeNativeCustomProviderAttachment({
      ...saved,
      transport: { ...saved.transport, gatewayName: "other" },
    }),
  ).toBeUndefined();
});

it("leaves HTTPS adapter state untouched when profile admission rejects a collision (#12636)", async () => {
  const ensure = httpsAdapter();
  await expect(
    prepareNativeCustomInference(input, {
      ensureHttpsAdapter: ensure,
      admitProfile: async () => {
        throw new Error("profile collision");
      },
      discoverAllowedSourceCidrs: () => [],
    }),
  ).rejects.toThrow("profile collision");
  expect(ensure).not.toHaveBeenCalled();
});

it("restores only an exact recorded adapter selection for credential reuse without adapter mutation (#12636)", async () => {
  const ensure = httpsAdapter();
  const selected = await prepareNativeCustomInference(input, {
    ensureHttpsAdapter: ensure,
    admitProfile: async () => {},
    discoverAllowedSourceCidrs: () => ["172.18.0.0/16"],
  });
  const saved = attachment(selected.prepared);
  expect(restoreNativeCustomInference(input, saved)).toEqual(selected.prepared);
  expect(ensure).toHaveBeenCalledOnce();
  expect(() =>
    restoreNativeCustomInference({ ...input, endpointUrl: "https://other.example.com/v1" }, saved),
  ).toThrow(/exact recorded endpoint/);
  expect(() => restoreNativeCustomInference({ ...input, gatewayName: "other" }, saved)).toThrow(
    /credential reuse/,
  );
  expect(() => restoreNativeCustomInference({ ...input, sandboxName: "beta" }, saved)).toThrow(
    /credential reuse/,
  );
  expect(() => restoreNativeCustomInference({ ...input, api: "openai-responses" }, saved)).toThrow(
    /credential reuse/,
  );
});

it("rejects unsupported APIs and private DNS answers before touching adapter state (#12636)", async () => {
  const ensure = httpsAdapter();
  const admit = vi.fn(async () => {});
  const deps = {
    ensureHttpsAdapter: ensure,
    admitProfile: admit,
    discoverAllowedSourceCidrs: () => [],
  };
  await expect(
    prepareNativeCustomInference({ ...input, api: "unsupported" }, deps),
  ).rejects.toThrow(/API/);
  await expect(
    prepareNativeCustomInference(
      { ...input, lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
      deps,
    ),
  ).rejects.toThrow(/private|internal/);
  expect(ensure).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
});

it("keeps Bedrock AWS custody in the existing adapter and binds only its OpenAI bridge (#12636)", async () => {
  vi.stubEnv("AWS_REGION", "us-east-1");
  const ensureBedrockAdapter = vi.fn(async () => ({
    baseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    localBaseUrl: "http://127.0.0.1/v1",
    logPath: "/tmp/bedrock.log",
    token: "bedrock-bridge-token",
    credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
    region: "us-east-1",
  }));
  const selected = await prepareNativeCustomInference(
    {
      ...input,
      provider: "compatible-anthropic-endpoint",
      endpointUrl: "https://bedrock-runtime-fips.us-east-1.amazonaws.com",
      api: "openai-completions",
    },
    {
      ensureBedrockAdapter,
      admitProfile: async () => {
        expect(ensureBedrockAdapter).not.toHaveBeenCalled();
      },
      discoverAllowedSourceCidrs: () => [],
    },
  );
  expect(ensureBedrockAdapter).toHaveBeenCalledWith(
    expect.objectContaining({
      compatibleCredential: "host-only-secret",
      classification: expect.objectContaining({ kind: "bedrock-runtime", fips: true }),
    }),
  );
  expect(selected.prepared).toMatchObject({
    api: "openai-completions",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    endpointUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  });
  const saved = attachment(selected.prepared);
  expect(normalizeNativeCustomProviderAttachment(saved)).toEqual(saved);
  expect(JSON.stringify(saved)).not.toMatch(/host-only-secret|bedrock-bridge-token/);
});

it("rejects an arbitrary managed-host endpoint without an owned adapter handoff (#12636)", async () => {
  const ensure = httpsAdapter();
  await expect(
    prepareNativeCustomInference(
      { ...input, endpointUrl: "http://host.openshell.internal:8080/v1" },
      {
        ensureHttpsAdapter: ensure,
        admitProfile: async () => {},
        discoverAllowedSourceCidrs: () => [],
      },
    ),
  ).rejects.toThrow();
  expect(ensure).not.toHaveBeenCalled();
});
