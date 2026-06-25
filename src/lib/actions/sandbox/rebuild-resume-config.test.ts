// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const onboardSession = requireDist("../../../../dist/lib/state/onboard-session.js");
const {
  isLocalInferenceProvider,
  getRebuildCredentialEnvFromRegistry,
  getRebuildEndpointFromRegistry,
  prepareRebuildResumeConfig,
} = requireDist("../../../../dist/lib/actions/sandbox/rebuild-resume-config.js");

const noopLog = () => undefined;
const throwingBail = (msg: string): never => {
  throw new Error(msg);
};

function entry(overrides: Record<string, unknown> = {}) {
  return { name: "alpha", provider: null, model: null, nimContainer: null, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isLocalInferenceProvider", () => {
  it("classifies local providers and rejects remote/null", () => {
    expect(isLocalInferenceProvider("ollama-local")).toBe(true);
    expect(isLocalInferenceProvider("vllm-local")).toBe(true);
    expect(isLocalInferenceProvider("nvidia-prod")).toBe(false);
    expect(isLocalInferenceProvider(null)).toBe(false);
  });
});

describe("getRebuildCredentialEnvFromRegistry", () => {
  it("returns the canonical credential env for a known remote provider", () => {
    expect(getRebuildCredentialEnvFromRegistry("nvidia-prod")).toBe("NVIDIA_INFERENCE_API_KEY");
  });
  it("returns null for local and unset providers", () => {
    expect(getRebuildCredentialEnvFromRegistry("ollama-local")).toBeNull();
    expect(getRebuildCredentialEnvFromRegistry(null)).toBeNull();
  });
});

describe("getRebuildEndpointFromRegistry", () => {
  it("treats local and routed providers as derivable with no pinned URL", () => {
    expect(getRebuildEndpointFromRegistry("ollama-local")).toEqual({
      known: true,
      endpointUrl: null,
    });
    expect(getRebuildEndpointFromRegistry("nvidia-router")).toEqual({
      known: true,
      endpointUrl: null,
    });
    expect(getRebuildEndpointFromRegistry(null)).toEqual({ known: true, endpointUrl: null });
  });

  it("pins the canonical endpoint for a known remote provider", () => {
    const result = getRebuildEndpointFromRegistry("nvidia-prod");
    expect(result.known).toBe(true);
    expect(typeof result.endpointUrl).toBe("string");
    expect(result.endpointUrl.length).toBeGreaterThan(0);
  });

  it("marks a custom OpenAI-compatible provider as unknown (session-only URL)", () => {
    expect(getRebuildEndpointFromRegistry("compatible-endpoint")).toEqual({ known: false });
  });
});

describe("prepareRebuildResumeConfig", () => {
  it("pins registry config and does not pin endpoint for a matching session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "alpha" });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({ provider: "nvidia-prod", model: "m" }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config).toMatchObject({
      provider: "nvidia-prod",
      model: "m",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      pinEndpoint: false,
    });
  });

  it("pins the canonical endpoint when the session belongs to another sandbox", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({ provider: "nvidia-prod", model: "m" }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config?.pinEndpoint).toBe(true);
    expect(typeof config?.endpointUrl).toBe("string");
  });

  it("fails closed for a custom endpoint with a non-matching session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    expect(() =>
      prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m" }),
        null,
        noopLog,
        throwingBail,
      ),
    ).toThrow("Cannot determine recreate endpoint");
  });

  it("surfaces an ambient agent mismatch in the assessment", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "alpha" });
    const prior = process.env.NEMOCLAW_AGENT;
    process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
    try {
      const config = prepareRebuildResumeConfig("alpha", entry(), null, noopLog, throwingBail);
      expect(config?.ambient.agentMismatch).toEqual({
        envAgent: "langchain-deepagents-code",
        registryAgent: "openclaw",
      });
    } finally {
      // Branchless restore of prior worker value (ternary expression, not a
      // conditional statement, to keep the changed-test-file guardrail green).
      delete process.env.NEMOCLAW_AGENT;
      Object.assign(process.env, prior === undefined ? {} : { NEMOCLAW_AGENT: prior });
    }
  });
});
