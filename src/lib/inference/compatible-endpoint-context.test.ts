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

function apply(
  options: Parameters<typeof applyCompatibleEndpointContextWindow>[2],
  env: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; messages: string[] } {
  const messages: string[] = [];
  applyCompatibleEndpointContextWindow("https://endpoint.example/v1", "model-a", {
    env,
    logger: {
      log: (message: string) => messages.push(message),
      warn: (message: string) => messages.push(message),
    },
    ...options,
  });
  return { env, messages };
}

describe("compatible-endpoint context window", () => {
  it("bakes the endpoint's max_model_len into NEMOCLAW_CONTEXT_WINDOW (#6177)", () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const { env, messages } = apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(fetchModels).toHaveBeenCalledWith("https://endpoint.example/v1", "");
    expect(messages.some((m) => m.includes("65536"))).toBe(true);
  });

  it("resolves the API key from the credential env for the probe", () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 32_768 }] }));
    apply({
      fetchModels,
      credentialEnv: "COMPATIBLE_API_KEY",
      resolveCredential: (name) => (name === "COMPATIBLE_API_KEY" ? "secret-key" : null),
    });

    expect(fetchModels).toHaveBeenCalledWith("https://endpoint.example/v1", "secret-key");
  });

  it("picks the exact model entry from a multi-model gateway response (#6177)", () => {
    const fetchModels = vi.fn(() => ({
      data: [
        { id: "other-model", max_model_len: 8_192 },
        { id: "model-a", max_model_len: 65_536 },
      ],
    }));
    const { env } = apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
  });

  it("does not guess a context window from a multi-model gateway with no exact match (#6177)", () => {
    const fetchModels = vi.fn(() => ({
      data: [
        { id: "other-a", max_model_len: 8_192 },
        { id: "other-b", max_model_len: 16_384 },
      ],
    }));
    const { env, messages } = apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes("none match 'model-a'"))).toBe(true);
  });

  it("uses the sole served model even when its id does not match (single-model endpoint)", () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "served-alias", max_model_len: 32_768 }] }));
    const { env } = apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("32768");
  });

  it("skips the probe for a sandbox-internal endpoint and leaves auto-detect (#6177)", () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const messages: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    applyCompatibleEndpointContextWindow("https://host.openshell.internal/v1", "model-a", {
      env,
      fetchModels,
      logger: { log: (m) => messages.push(m), warn: (m) => messages.push(m) },
    });

    expect(fetchModels).not.toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages).toEqual([]);
  });

  it("never downgrades an explicit NEMOCLAW_CONTEXT_WINDOW override (#6177)", () => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 8_192 }] }));
    const { env, messages } = apply({ fetchModels }, { NEMOCLAW_CONTEXT_WINDOW: "65536" });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    expect(fetchModels).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes("Keeping configured context window"))).toBe(true);
  });

  it("warns and keeps the default context window when the endpoint cannot be probed", () => {
    const fetchModels = vi.fn(() => null);
    const { env, messages } = apply({ fetchModels });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes("Could not read the endpoint's /v1/models"))).toBe(true);
  });

  it("skips the real host fetch under the unit-test runner unless one is injected", () => {
    const { env, messages } = apply({}, { VITEST: "true" });

    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages).toEqual([]);
  });

  it("clears its own stale auto value when a re-probed endpoint reports nothing (#6177)", () => {
    // First endpoint auto-detects 65536 into the shared env.
    const env: NodeJS.ProcessEnv = {};
    apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) }, env);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");

    // A later selection pass probes an endpoint that reports no max_model_len:
    // the stale auto value must not survive (would look like a user override).
    apply({ fetchModels: () => ({ data: [{ id: "model-a" }] }) }, env);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it("recomputes over its own prior auto value on a re-probe (#6177)", () => {
    const env: NodeJS.ProcessEnv = {};
    apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) }, env);
    apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 16_384 }] }) }, env);
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("16384");
  });

  it("keeps a genuine user override even after a prior auto value was recorded (#6177)", () => {
    const env: NodeJS.ProcessEnv = {};
    apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) }, env);
    // User pins a different value; a later probe must not overwrite it.
    env.NEMOCLAW_CONTEXT_WINDOW = "200000";
    const { messages } = apply(
      { fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 16_384 }] }) },
      env,
    );
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("200000");
    expect(messages.some((m) => m.includes("Keeping configured context window"))).toBe(true);
  });

  it("does not crash on a malformed /v1/models body from an arbitrary endpoint (#6177)", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() =>
      apply({ fetchModels: () => ({ data: [null, "nope", 42] }) as unknown as object }, env),
    ).not.toThrow();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it.each([
    "http://10.0.0.1/v1",
    "http://127.0.0.1/v1",
    "http://169.254.169.254/v1",
    "http://172.16.0.1/v1",
    "http://192.168.1.1/v1",
  ])("rejects the private-IP endpoint %s before probing /v1/models (SSRF, #6293)", (endpointUrl) => {
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }));
    const messages: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    applyCompatibleEndpointContextWindow(endpointUrl, "model-a", {
      env,
      fetchModels,
      logger: { log: (m) => messages.push(m), warn: (m) => messages.push(m) },
    });

    expect(fetchModels).not.toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(messages.some((m) => m.includes("private/internal address"))).toBe(true);
  });

  it("clears a stale auto value when re-probing a now private-IP endpoint (SSRF, #6293)", () => {
    const env: NodeJS.ProcessEnv = {};
    // First endpoint auto-detects a window into the shared env.
    applyCompatibleEndpointContextWindow("https://public.example/v1", "model-a", {
      env,
      fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }),
      logger: { log: () => undefined, warn: () => undefined },
    });
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");

    // A later pass selects a private-IP endpoint: the probe must be refused and
    // the stale auto value dropped rather than left as a phantom user override.
    const fetchModels = vi.fn(() => ({ data: [{ id: "model-a", max_model_len: 8_192 }] }));
    applyCompatibleEndpointContextWindow("http://10.0.0.1/v1", "model-a", {
      env,
      fetchModels,
      logger: { log: () => undefined, warn: () => undefined },
    });
    expect(fetchModels).not.toHaveBeenCalled();
    expect(env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
  });

  it("clearAutoDetectedCompatibleContextWindow drops a stale auto value but keeps a user override (#6177)", () => {
    // Auto-detected value is cleared when retrying away to another provider.
    const autoEnv: NodeJS.ProcessEnv = {};
    apply({ fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }) }, autoEnv);
    expect(autoEnv.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");
    clearAutoDetectedCompatibleContextWindow(autoEnv);
    expect(autoEnv.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();

    // A user-supplied value this probe never wrote survives the clear.
    const userEnv: NodeJS.ProcessEnv = { NEMOCLAW_CONTEXT_WINDOW: "200000" };
    clearAutoDetectedCompatibleContextWindow(userEnv);
    expect(userEnv.NEMOCLAW_CONTEXT_WINDOW).toBe("200000");
  });
});
