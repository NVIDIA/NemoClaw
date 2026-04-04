// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure validation and failure-classification functions.
 *
 * No I/O, no side effects — takes strings/numbers in, returns typed results.
 */

export interface ValidationClassification {
  kind: "transport" | "credential" | "model" | "endpoint" | "unknown";
  retry: "retry" | "credential" | "model" | "selection";
}

export interface SandboxCreateFailure {
  kind: "image_transfer_timeout" | "image_transfer_reset" | "sandbox_create_incomplete" | "unknown";
  uploadedToGateway: boolean;
}

export function classifyValidationFailure({
  httpStatus = 0,
  curlStatus = 0,
  message = "",
} = {}): ValidationClassification {
  const normalized = String(message).replace(/\s+/g, " ").trim().toLowerCase();
  if (curlStatus) {
    return { kind: "transport", retry: "retry" };
  }
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600)) {
    return { kind: "transport", retry: "retry" };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "credential", retry: "credential" };
  }
  if (httpStatus === 400) {
    return { kind: "model", retry: "model" };
  }
  if (/model.+not found|unknown model|unsupported model|bad model/i.test(normalized)) {
    return { kind: "model", retry: "model" };
  }
  if (httpStatus === 404 || httpStatus === 405) {
    return { kind: "endpoint", retry: "selection" };
  }
  if (/unauthorized|forbidden|invalid api key|invalid_auth|permission/i.test(normalized)) {
    return { kind: "credential", retry: "credential" };
  }
  return { kind: "unknown", retry: "selection" };
}

export function classifyApplyFailure(message = ""): ValidationClassification {
  return classifyValidationFailure({ message });
}

export function classifySandboxCreateFailure(output = ""): SandboxCreateFailure {
  const text = String(output || "");
  const uploadedToGateway =
    /\[progress\]\s+Uploaded to gateway/i.test(text) ||
    /Image .*available in the gateway/i.test(text);

  if (/failed to read image export stream|Timeout error/i.test(text)) {
    return { kind: "image_transfer_timeout", uploadedToGateway };
  }
  if (/Connection reset by peer/i.test(text)) {
    return { kind: "image_transfer_reset", uploadedToGateway };
  }
  if (/Created sandbox:/i.test(text)) {
    return { kind: "sandbox_create_incomplete", uploadedToGateway: true };
  }
  return { kind: "unknown", uploadedToGateway };
}

export function validateNvidiaApiKeyValue(key: string): string | null {
  if (!key) {
    return "  NVIDIA API Key is required.";
  }
  if (!key.startsWith("nvapi-")) {
    return "  Invalid key. Must start with nvapi-";
  }
  return null;
}

export function isSafeModelId(value: string): boolean {
  return /^[A-Za-z0-9._:/-]+$/.test(value);
}
