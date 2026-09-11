// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { curlFailure, response, scriptedProbe } from "../__test-helpers__/attachment-probe";
import type { CurlProbeResult } from "../../adapters/http/probe";
import {
  isSafeLlmmanModelReference,
  LLMMAN_HOST_OPENAI_BASE_URL,
  LLMMAN_PORT,
  probeLlmmanAttachment,
  selectLlmmanModelReference,
} from "./index";

const LLMMAN_VERSION_BODY = JSON.stringify({
  version: "0.9.3",
  exe: "/usr/local/bin/llmman",
  pid: 4242,
});
const OLLAMA_VERSION_BODY = JSON.stringify({ version: "0.32.9" });

function tags(...names: string[]): string {
  return JSON.stringify({
    models: names.map((name) => ({
      name,
      model: name,
      size: 1024,
      digest: "sha256:abc",
      modified_at: "2026-09-01T00:00:00Z",
      details: { format: "gguf" },
    })),
  });
}

function authenticatedResponses(...models: string[]): CurlProbeResult[] {
  return [
    response(401, '{"error":"unauthorized"}'),
    response(200, LLMMAN_VERSION_BODY),
    response(200, tags(...models)),
  ];
}

describe("llmman contract", () => {
  it("attaches on llmman's default loopback port", () => {
    expect(LLMMAN_PORT).toBe(17434);
    expect(LLMMAN_HOST_OPENAI_BASE_URL).toBe("http://127.0.0.1:17434/v1");
  });
});

describe("isSafeLlmmanModelReference", () => {
  it.each([
    "qwen3.8",
    "n/gemma4:latest",
    "hf.co/unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
    "docker.io/ai/gemma4",
    "localhost:5000/team/model:v1",
  ])("accepts OCI and Hugging Face model reference %s", (reference) => {
    expect(isSafeLlmmanModelReference(reference)).toBe(true);
  });

  it.each([
    "",
    " qwen3.8",
    "/models/model.gguf",
    "./model",
    "~/model",
    "team/../model",
    "C:\\models\\model",
    "file:model",
    "model.gguf",
    "team/model@sha256:abc",
    "a".repeat(257),
  ])("rejects unsafe model reference %j", (reference) => {
    expect(isSafeLlmmanModelReference(reference)).toBe(false);
  });
});

describe("selectLlmmanModelReference", () => {
  it("matches an exact stored reference", () => {
    expect(
      selectLlmmanModelReference(["qwen3.8:latest", "n/gemma4:latest"], "n/gemma4:latest"),
    ).toBe("n/gemma4:latest");
  });

  it("resolves an untagged request to the stored :latest image", () => {
    expect(selectLlmmanModelReference(["qwen3.8:latest"], "qwen3.8")).toBe("qwen3.8:latest");
  });

  it("does not treat a registry port as a tag", () => {
    expect(
      selectLlmmanModelReference(["localhost:5000/model:latest"], "localhost:5000/model"),
    ).toBe("localhost:5000/model:latest");
  });

  it("returns null for a tagged request that is not stored", () => {
    expect(selectLlmmanModelReference(["qwen3.8:latest"], "qwen3.8:q8")).toBeNull();
  });
});

describe("probeLlmmanAttachment", () => {
  it("requires an operator-supplied llmman API key", () => {
    expect(probeLlmmanAttachment("  ")).toMatchObject({
      ok: false,
      reason: "authentication-required",
    });
  });

  it.each(["http://127.0.0.1:11434", "http://192.0.2.10:17434", "https://127.0.0.1:17434"])(
    "rejects attachment endpoint %s outside fixed loopback port 17434",
    (baseUrl) => {
      const probe = vi.fn();
      expect(
        probeLlmmanAttachment("secret-token", { baseUrl, runCurlProbeImpl: probe }),
      ).toMatchObject({ ok: false, reason: "invalid-endpoint" });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("attaches the single stored model of an authenticated llmman daemon", () => {
    const probe = scriptedProbe(authenticatedResponses("qwen3.8:latest"));

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toEqual({
      ok: true,
      model: "qwen3.8:latest",
      version: "0.9.3",
      availableModels: ["qwen3.8:latest"],
    });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls[0]?.[0]).toContain("http://127.0.0.1:17434/api/version");
    expect(probe.mock.calls[2]?.[0]).toContain("http://127.0.0.1:17434/api/tags");
    probe.mock.calls.forEach(([argv, options]) => {
      expect(argv).toEqual(expect.arrayContaining(["--max-time", "5", "--max-filesize", "262144"]));
      expect(options).toEqual(expect.objectContaining({ maxResponseBytes: 262144 }));
    });
  });

  it("sends the API key only after the anonymous probe proves the daemon requires one", () => {
    const probe = scriptedProbe(authenticatedResponses("qwen3.8:latest"));

    probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe });

    const [anonymousArgv, anonymousOptions] = probe.mock.calls[0]!;
    expect(anonymousArgv).not.toContain("--config");
    expect(anonymousOptions?.trustedConfigFiles).toBeUndefined();
    const authenticatedCalls = probe.mock.calls.slice(1);
    expect(authenticatedCalls).toHaveLength(2);
    authenticatedCalls.forEach(([argv, options]) => {
      expect(argv).toContain("--config");
      expect(options?.trustedConfigFiles).toHaveLength(1);
    });
  });

  it("reports an unreachable daemon with the serve remediation", () => {
    const probe = scriptedProbe([curlFailure(7)]);

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "unreachable",
      message: expect.stringContaining("llmman serve"),
    });
  });

  it("refuses an llmman daemon that answers without an API key", () => {
    const probe = scriptedProbe([response(200, LLMMAN_VERSION_BODY)]);

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "authentication-required",
      message: expect.stringContaining("LLMMAN_API_KEYS"),
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("refuses an open Ollama daemon on the llmman port", () => {
    const probe = scriptedProbe([response(200, OLLAMA_VERSION_BODY)]);

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "not-llmman",
    });
  });

  it("refuses an authenticated server whose version identity is not llmman's", () => {
    const probe = scriptedProbe([
      response(401, '{"error":"unauthorized"}'),
      response(200, OLLAMA_VERSION_BODY),
    ]);

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "not-llmman",
      message: expect.stringContaining("version, exe, pid"),
    });
  });

  it("reports a rejected API key", () => {
    const probe = scriptedProbe([
      response(401, '{"error":"unauthorized"}'),
      response(401, '{"error":"unauthorized"}'),
    ]);

    expect(probeLlmmanAttachment("wrong-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "authentication-rejected",
    });
  });

  it.each([
    ["oversized-response", 63],
    ["probe-timeout", 28],
  ])("fails closed on bounded probe failure %s", (reason, curlStatus) => {
    const probe = scriptedProbe([
      response(401, '{"error":"unauthorized"}'),
      response(200, LLMMAN_VERSION_BODY),
      curlFailure(curlStatus),
    ]);

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("rejects a malformed model catalog", () => {
    const probe = scriptedProbe([
      response(401, '{"error":"unauthorized"}'),
      response(200, LLMMAN_VERSION_BODY),
      response(200, '{"models":[{"size":1}]}'),
    ]);

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "malformed-fingerprint",
    });
  });

  it("selects the requested stored model, resolving an untagged request to :latest", () => {
    const probe = scriptedProbe(authenticatedResponses("qwen3.8:latest", "n/gemma4:latest"));

    expect(
      probeLlmmanAttachment("secret-token", {
        runCurlProbeImpl: probe,
        requestedModel: "n/gemma4",
      }),
    ).toMatchObject({ ok: true, model: "n/gemma4:latest" });
  });

  it("reports a requested model that is not stored with the pull remediation", () => {
    const probe = scriptedProbe(authenticatedResponses("qwen3.8:latest"));

    expect(
      probeLlmmanAttachment("secret-token", {
        runCurlProbeImpl: probe,
        requestedModel: "hf.co/unsloth/Qwen3.5-0.8B-GGUF",
      }),
    ).toEqual({
      ok: false,
      reason: "model-not-found",
      message: expect.stringContaining("llmman pull hf.co/unsloth/Qwen3.5-0.8B-GGUF"),
      availableModels: ["qwen3.8:latest"],
    });
  });

  it("returns the stored catalog when no model was requested and several are stored", () => {
    const probe = scriptedProbe(authenticatedResponses("qwen3.8:latest", "n/gemma4:latest"));

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toEqual({
      ok: false,
      reason: "ambiguous-model",
      message: expect.stringContaining("multiple models"),
      availableModels: ["qwen3.8:latest", "n/gemma4:latest"],
    });
  });

  it("tells the operator to pull a model when the store is empty", () => {
    const probe = scriptedProbe(authenticatedResponses());

    expect(probeLlmmanAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "ambiguous-model",
      message: expect.stringContaining("llmman pull"),
      availableModels: [],
    });
  });

  it("refuses a stored reference that is not a safe sandbox model id", () => {
    const probe = scriptedProbe(authenticatedResponses("team/model@sha256:abc"));

    expect(
      probeLlmmanAttachment("secret-token", {
        runCurlProbeImpl: probe,
        requestedModel: "team/model@sha256:abc",
      }),
    ).toMatchObject({ ok: false, reason: "unsafe-model-reference" });
  });
});
