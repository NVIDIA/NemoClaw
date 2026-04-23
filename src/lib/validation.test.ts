// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  classifyValidationFailure,
  classifyApplyFailure,
  classifySandboxCreateFailure,
  validateNvidiaApiKeyValue,
  isSafeModelId,
  isNvcfFunctionNotFoundForAccount,
  nvcfFunctionNotFoundMessage,
  shouldSkipResponsesProbe,
  shouldForceCompletionsApi,
} from "../../dist/lib/validation";

describe("classifyValidationFailure", () => {
  it("classifies curl failures as transport", () => {
    expect(classifyValidationFailure({ curlStatus: 7 })).toEqual({
      kind: "transport",
      retry: "retry",
    });
  });

  it("classifies 429 as transport", () => {
    expect(classifyValidationFailure({ httpStatus: 429 })).toEqual({
      kind: "transport",
      retry: "retry",
    });
  });

  it("classifies 5xx as transport", () => {
    expect(classifyValidationFailure({ httpStatus: 502 })).toEqual({
      kind: "transport",
      retry: "retry",
    });
  });

  it("classifies 401 as credential", () => {
    expect(classifyValidationFailure({ httpStatus: 401 })).toEqual({
      kind: "credential",
      retry: "credential",
    });
  });

  it("classifies 403 as credential", () => {
    expect(classifyValidationFailure({ httpStatus: 403 })).toEqual({
      kind: "credential",
      retry: "credential",
    });
  });

  it("classifies 400 as model", () => {
    expect(classifyValidationFailure({ httpStatus: 400 })).toEqual({
      kind: "model",
      retry: "model",
    });
  });

  it("classifies 400 + expired key message as credential (#1942 — Gemini)", () => {
    // Gemini returns HTTP 400 with this exact message when the API key has expired.
    // Must classify as "credential" so the onboard wizard prompts to re-enter the
    // key instead of looping back to provider selection.
    expect(
      classifyValidationFailure({
        httpStatus: 400,
        message: "API key expired. Please renew the API key.",
      }),
    ).toEqual({
      kind: "credential",
      retry: "credential",
    });
  });

  it("classifies 400 + API_KEY_INVALID message as credential (#1942 — Gemini)", () => {
    // Gemini also uses "API_KEY_INVALID" as the status string for revoked keys.
    expect(
      classifyValidationFailure({
        httpStatus: 400,
        message: "API_KEY_INVALID: API key not valid. Please pass a valid API key.",
      }),
    ).toEqual({
      kind: "credential",
      retry: "credential",
    });
  });

  it("classifies bare 'API key not valid' message as credential (#1942 — Gemini .message only)", () => {
    // When the message field is extracted without the API_KEY_INVALID status
    // prefix, the bare wording must still classify as credential. Flagged by
    // CodeRabbit on #2132.
    expect(
      classifyValidationFailure({
        httpStatus: 400,
        message: "API key not valid. Please pass a valid API key.",
      }),
    ).toEqual({
      kind: "credential",
      retry: "credential",
    });
  });

  it("classifies 400 without credential message as model (regression guard)", () => {
    // HTTP 400 without a credential-bearing message still routes to "model"
    // so existing gemini model-selection retry behavior stays intact.
    expect(
      classifyValidationFailure({ httpStatus: 400, message: "model xyz not found" }),
    ).toEqual({
      kind: "model",
      retry: "model",
    });
  });

  it("classifies model-not-found message as model", () => {
    expect(classifyValidationFailure({ message: "model xyz not found" })).toEqual({
      kind: "model",
      retry: "model",
    });
  });

  it("classifies 404 as endpoint", () => {
    expect(classifyValidationFailure({ httpStatus: 404 })).toEqual({
      kind: "endpoint",
      retry: "selection",
    });
  });

  it("classifies unauthorized message as credential", () => {
    expect(classifyValidationFailure({ message: "Unauthorized access" })).toEqual({
      kind: "credential",
      retry: "credential",
    });
  });

  it("returns unknown for unrecognized failures", () => {
    expect(classifyValidationFailure({ httpStatus: 418 })).toEqual({
      kind: "unknown",
      retry: "selection",
    });
  });

  it("handles no arguments", () => {
    expect(classifyValidationFailure()).toEqual({ kind: "unknown", retry: "selection" });
  });
});

describe("classifyApplyFailure", () => {
  it("delegates to classifyValidationFailure", () => {
    expect(classifyApplyFailure("unauthorized")).toEqual({
      kind: "credential",
      retry: "credential",
    });
  });
});

describe("classifySandboxCreateFailure", () => {
  it("detects image transfer timeout", () => {
    const result = classifySandboxCreateFailure("failed to read image export stream");
    expect(result.kind).toBe("image_transfer_timeout");
  });

  it("detects connection reset", () => {
    const result = classifySandboxCreateFailure("Connection reset by peer");
    expect(result.kind).toBe("image_transfer_reset");
  });

  it("detects incomplete sandbox creation", () => {
    const result = classifySandboxCreateFailure("Created sandbox: test");
    expect(result.kind).toBe("sandbox_create_incomplete");
    expect(result.uploadedToGateway).toBe(true);
  });

  it("detects upload progress", () => {
    const result = classifySandboxCreateFailure(
      "[progress] Uploaded to gateway\nfailed to read image export stream",
    );
    expect(result.uploadedToGateway).toBe(true);
  });

  it("returns unknown for unrecognized output", () => {
    const result = classifySandboxCreateFailure("something else happened");
    expect(result.kind).toBe("unknown");
  });
});

describe("validateNvidiaApiKeyValue", () => {
  it("returns null for valid key", () => {
    expect(validateNvidiaApiKeyValue("nvapi-abc123")).toBeNull();
  });

  it("rejects empty key", () => {
    expect(validateNvidiaApiKeyValue("")).toBeTruthy();
  });

  it("rejects key without nvapi- prefix", () => {
    expect(validateNvidiaApiKeyValue("sk-abc123")).toBeTruthy();
  });
});

describe("isSafeModelId", () => {
  it("accepts valid model IDs", () => {
    expect(isSafeModelId("nvidia/nemotron-3-super-120b-a12b")).toBe(true);
    expect(isSafeModelId("gpt-5.4")).toBe(true);
    expect(isSafeModelId("claude-sonnet-4-6")).toBe(true);
  });

  it("rejects IDs with spaces or special chars", () => {
    expect(isSafeModelId("model name")).toBe(false);
    expect(isSafeModelId("model;rm -rf /")).toBe(false);
    expect(isSafeModelId("")).toBe(false);
  });
});

describe("isNvcfFunctionNotFoundForAccount", () => {
  it("matches the literal NVCF detail string from /v1/chat/completions", () => {
    expect(
      isNvcfFunctionNotFoundForAccount(
        "Function '767b5b9a-3f9d-4c1d-86e8-fa861988cee7': Not found for account 'yBLCN5kgzhvIn_SHbXDVGyQ-wEuSUKmFoZaC_JpS30c'",
      ),
    ).toBe(true);
  });

  it("matches when wrapped inside an HTTP error summary", () => {
    expect(
      isNvcfFunctionNotFoundForAccount("HTTP 404: Function 'abc123': Not found for account 'xyz'"),
    ).toBe(true);
  });

  it("is case-insensitive on the 'Not found for account' clause", () => {
    expect(isNvcfFunctionNotFoundForAccount("Function 'abc': not FOUND for ACCOUNT 'xyz'")).toBe(
      true,
    );
  });

  it("does not match generic 404 page-not-found bodies", () => {
    expect(isNvcfFunctionNotFoundForAccount("404 page not found")).toBe(false);
  });

  it("does not match unrelated errors", () => {
    expect(isNvcfFunctionNotFoundForAccount("Connection refused")).toBe(false);
    expect(isNvcfFunctionNotFoundForAccount("")).toBe(false);
  });
});

describe("nvcfFunctionNotFoundMessage", () => {
  it("includes the model id and points the user at build.nvidia.com", () => {
    const msg = nvcfFunctionNotFoundMessage("mistralai/mistral-large");
    expect(msg).toContain("mistralai/mistral-large");
    expect(msg).toContain("not deployed for your account");
    expect(msg).toContain("https://build.nvidia.com");
  });

  it("opens with 'Model <id> not found' so classifyValidationFailure routes to the model recovery path", () => {
    // classifyValidationFailure() in this same file matches /model.+not found/i
    // and uses that to return { kind: "model", retry: "model" }. The reframed
    // message must hit that regex so the wizard prompts the user to pick a
    // different model instead of falling through to the generic recovery.
    const msg = nvcfFunctionNotFoundMessage("mistralai/mistral-large");
    expect(msg).toMatch(/model.+not found/i);
    expect(classifyValidationFailure({ message: msg })).toEqual({
      kind: "model",
      retry: "model",
    });
  });
});

describe("shouldSkipResponsesProbe", () => {
  it("skips the Responses probe for nvidia-prod (Build does not expose /v1/responses)", () => {
    expect(shouldSkipResponsesProbe("nvidia-prod")).toBe(true);
  });

  it("skips the Responses probe for gemini-api (Gemini does not support /v1/responses)", () => {
    expect(shouldSkipResponsesProbe("gemini-api")).toBe(true);
  });

  it("does not skip the Responses probe for other providers", () => {
    expect(shouldSkipResponsesProbe("openai-api")).toBe(false);
    expect(shouldSkipResponsesProbe("anthropic-api")).toBe(false);
    expect(shouldSkipResponsesProbe("compatible-endpoint")).toBe(false);
    expect(shouldSkipResponsesProbe("")).toBe(false);
  });
});

describe("shouldForceCompletionsApi", () => {
  it("returns true when passed openai-completions", () => {
    expect(shouldForceCompletionsApi("openai-completions")).toBe(true);
  });

  it("returns true for the chat-completions alias", () => {
    expect(shouldForceCompletionsApi("chat-completions")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(shouldForceCompletionsApi("OpenAI-Completions")).toBe(true);
  });

  it("returns false when undefined", () => {
    expect(shouldForceCompletionsApi(undefined)).toBe(false);
  });

  it("returns false for openai-responses", () => {
    expect(shouldForceCompletionsApi("openai-responses")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(shouldForceCompletionsApi("")).toBe(false);
  });
});
