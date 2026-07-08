// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyCompatibleEndpointContextWindow,
  clearAutoDetectedCompatibleContextWindow,
  resetCompatibleEndpointContextWindowAutoState,
} from "./compatible-endpoint-context";

beforeEach(() => {
  resetCompatibleEndpointContextWindowAutoState();
});

async function apply(
  options: Parameters<typeof applyCompatibleEndpointContextWindow>[2],
  env: NodeJS.ProcessEnv = {},
): Promise<{ env: NodeJS.ProcessEnv; messages: string[] }> {
  const messages: string[] = [];
  await applyCompatibleEndpointContextWindow("https://endpoint.example/v1", "model-a", {
    env,
    logger: {
      log: (message: string) => messages.push(message),
      warn: (message: string) => messages.push(message),
    },
    // Inject a clearly-public resolver so the unconditional DNS SSRF preflight
    // passes for the endpoint.example host these cases probe (#6293). Cases that
    // exercise SSRF refusal use inline calls with a private-address resolver.
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    ...options,
  });
  return { env, messages };
}

describe("compatible-endpoint context window", () => {
  it("bakes the endpoint's max_model_len into NEMOCLAW_CONTEXT_WINDOW (#6177)", async () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const { env, messages } = await apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(fetchModels).toHaveBeenCalledWith("https://endpoint.example/v1", "", ["93.184.216.34"]);
    expect(messages.some((m) => m.includes("65536"))).toBe(true);
  });

  it("resolves the API key from the credential env for the probe", async () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 32_768 }] }));
    await apply({
      fetchModels,
      credentialEnv: "COMPATIBLE_API_KEY",
      resolveCredential: (name) => (name === "COMPATIBLE_API_KEY" ? "secret-key" : null),
    });

    expect(fetchModels).toHaveBeenCalledWith("https://endpoint.example/v1", "secret-key", [
      "93.184.216.34",
    ]);
  });

  it("picks the exact model entry from a multi-model gateway response (#6177)", async () => {
    const fetchModels = vi.fn(() => ({
      data: [
        { id: "other-model", max_model_len: 8_192 },
        { id: "model-a", max_model_len: 65_536 },
      ],
    }));
    const { env } = await apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
  });

  it("does not guess a context window from a multi-model gateway with no exact match (#6177)", async () => {
    const fetchModels = vi.fn(() => ({
      data: [
        { id: "other-a", max_model_len: 8_192 },
        { id: "other-b", max_model_len: 16_384 },
      ],
    }));
    const { env, messages } = await apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes("none match 'model-a'"))).toBe(true);
  });

  it("uses the sole served model even when its id does not match (single-model endpoint)", async () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "served-alias", max_model_len: 32_768 }] }));
    const { env } = await apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");
  });

  it("skips the probe for a sandbox-internal endpoint and leaves auto-detect (#6177)", async () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const messages: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow("https://host.openshell.internal/v1", "model-a", {
      env,
      fetchModels,
      logger: { log: (m) => messages.push(m), warn: (m) => messages.push(m) },
    });

    expect(fetchModels).not.toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages).toEqual([]);
  });

  it("never downgrades an explicit NEMOCLAW_CONTEXT_WINDOW override (#6177)", async () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 8_192 }] }));
    const { env, messages } = await apply({ fetchModels }, { NEMOCLAW_CONTEXT_WINDOW: "65536" });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(fetchModels).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("Keeping configured context window"))).toBe(true);
  });

  it.each([
    "0",
    "abc",
    "-5",
    "9999999999",
  ])("ignores the invalid NEMOCLAW_CONTEXT_WINDOW override %j and auto-detects instead (#6293)", async (badValue) => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 32_768 }] }));
    const { env, messages } = await apply({ fetchModels }, { NEMOCLAW_CONTEXT_WINDOW: badValue });

    expect(fetchModels).toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");
    expect(messages.some((m) => m.includes("Ignoring invalid NEMOCLAW_CONTEXT_WINDOW"))).toBe(true);
  });

  it("clears an invalid explicit override when the endpoint also cannot be probed (#6293)", async () => {
    const fetchModels = vi.fn(() => null);
    const { env } = await apply({ fetchModels }, { NEMOCLAW_CONTEXT_WINDOW: "0" });

    expect(fetchModels).toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it("warns and keeps the default context window when the endpoint cannot be probed", async () => {
    const fetchModels = vi.fn(() => null);
    const { env, messages } = await apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes("Could not read the endpoint's /v1/models"))).toBe(true);
  });

  it("clears its own stale auto value when a re-probed endpoint reports nothing (#6177)", async () => {
    // First endpoint auto-detects 65536 into the shared env.
    const env: NodeJS.ProcessEnv = {};
    await apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) }, env);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");

    // A later selection pass probes an endpoint that reports no max_model_len:
    // the stale auto value must not survive (would look like a user override).
    await apply({ fetchModels: () => ({ data: [{ id: "model-a" }] }) }, env);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it("recomputes over its own prior auto value on a re-probe (#6177)", async () => {
    const env: NodeJS.ProcessEnv = {};
    await apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) }, env);
    await apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 16_384 }] }) }, env);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("16384");
  });

  it("keeps a genuine user override even after a prior auto value was recorded (#6177)", async () => {
    const env: NodeJS.ProcessEnv = {};
    await apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) }, env);
    // User pins a different value; a later probe must not overwrite it.
    env.NEMOCLAW_CONTEXT_WINDOW = "200000";
    const { messages } = await apply(
      { fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 16_384 }] }) },
      env,
    );
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("200000");
    expect(messages.some((m) => m.includes("Keeping configured context window"))).toBe(true);
  });

  it("does not crash on a malformed /v1/models body from an arbitrary endpoint (#6177)", async () => {
    const env: NodeJS.ProcessEnv = {};
    // apply resolves (never throws) even on a malformed body; reaching the
    // assertion proves it did not crash.
    await apply({ fetchModels: () => ({ data: [null, "nope", 42] }) as unknown as object }, env);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it.each([
    "http://10.0.0.1/v1",
    "http://169.254.169.254/v1",
    "http://172.16.0.1/v1",
    "http://192.168.1.1/v1",
  ])("rejects the non-loopback private-IP endpoint %s before probing /v1/models SSRF (#6293)", async (endpointUrl) => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const messages: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(endpointUrl, "model-a", {
      env,
      fetchModels,
      logger: { log: (m) => messages.push(m), warn: (m) => messages.push(m) },
    });

    expect(fetchModels).not.toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes("private/internal address"))).toBe(true);
  });

  it.each([
    "http://127.0.0.1:8000/v1",
    "http://localhost:8000/v1",
    "http://[::1]:8000/v1",
  ])("probes a loopback endpoint %s and propagates its max_model_len (#6293)", async (endpointUrl) => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow(endpointUrl, "model-a", {
      env,
      fetchModels,
      logger: { log: () => undefined, warn: () => undefined },
    });

    expect(fetchModels).toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
  });

  it.each([
    "10.0.0.8",
    "169.254.169.254",
  ])("refuses the /v1/models probe when a public host resolves to private %s via the DNS preflight (#6293)", async (privateAddress) => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const messages: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow("https://public-name.example/v1", "model-a", {
      env,
      fetchModels,
      resolveHost: async () => [{ address: privateAddress, family: 4 }],
      logger: { log: (m) => messages.push(m), warn: (m) => messages.push(m) },
    });

    expect(fetchModels).not.toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes(privateAddress))).toBe(true);
  });

  it("probes when the injected resolver returns a public address (#6293)", async () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const env: NodeJS.ProcessEnv = {};
    await applyCompatibleEndpointContextWindow("https://public-name.example/v1", "model-a", {
      env,
      fetchModels,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      logger: { log: () => undefined, warn: () => undefined },
    });

    expect(fetchModels).toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
  });

  it("clears a stale auto value when re-probing a now private-IP endpoint SSRF (#6293)", async () => {
    const env: NodeJS.ProcessEnv = {};
    // First endpoint auto-detects a window into the shared env.
    await applyCompatibleEndpointContextWindow("https://public.example/v1", "model-a", {
      env,
      fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      logger: { log: () => undefined, warn: () => undefined },
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");

    // A later pass selects a private-IP endpoint: the probe must be refused and
    // the stale auto value dropped rather than left as a phantom user override.
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 8_192 }] }));
    await applyCompatibleEndpointContextWindow("http://10.0.0.1/v1", "model-a", {
      env,
      fetchModels,
      logger: { log: () => undefined, warn: () => undefined },
    });
    expect(fetchModels).not.toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it("clearAutoDetectedCompatibleContextWindow drops a stale auto value but keeps a user override (#6177)", async () => {
    // Auto-detected value is cleared when retrying away to another provider.
    const autoEnv: NodeJS.ProcessEnv = {};
    await apply(
      { fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) },
      autoEnv,
    );
    expect(autoEnv.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    clearAutoDetectedCompatibleContextWindow(autoEnv);
    expect(autoEnv.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();

    // A user-supplied value this probe never wrote survives the clear.
    const userEnv: NodeJS.ProcessEnv = { NEMOCLAW_CONTEXT_WINDOW: "200000" };
    clearAutoDetectedCompatibleContextWindow(userEnv);
    expect(userEnv.NEMOCLAW_CONTEXT_WINDOW).toBe("200000");
  });
});
