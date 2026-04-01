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
