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
  // Credential-bearing error messages take precedence over the HTTP 400
  // "model" default because some providers (notably Google Gemini) return
  // HTTP 400 with "API key expired. Please renew the API key." — without
  // this check the onboard flow skips the key re-entry prompt and loops
  // back to provider selection. See #1942.
  if (
    /api key (expired|not valid)|api[_ ]key[_ ]invalid|unauthorized|forbidden|invalid api key|invalid_auth|permission/i.test(
      normalized,
    )
  ) {
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

/**
 * Detect NVIDIA Cloud Functions "Function not found for account" errors.
 *
 * NVIDIA Build (integrate.api.nvidia.com) returns this when a model is in the
 * public catalog but is not deployed for the caller's account/org. The raw
 * body looks like:
 *
 *   {"status":404,"title":"Not Found",
 *    "detail":"Function '<uuid>': Not found for account '<account-id>'"}
 *
 * Detecting this lets the wizard surface an actionable error instead of the
 * raw NVCF body. See issue #1601.
 */
export function isNvcfFunctionNotFoundForAccount(message: string): boolean {
  return /Function\s+'[^']+':\s*Not found for account/i.test(String(message || ""));
}

/**
 * Build the user-facing message for an NVCF "Function not found for account"
 * failure. The model is in the catalog but cannot be invoked from this key.
 *
 * The wording deliberately starts with "Model '<id>' not found" so that
 * `classifyValidationFailure()` matches its `model.+not found` regex and
 * routes the user into the model-selection recovery path instead of
 * collapsing to the generic `unknown`/`selection` branch.
 */
export function nvcfFunctionNotFoundMessage(model: string): string {
  return (
    `Model '${model}' not found — it is in the NVIDIA Build catalog but is not deployed ` +
    "for your account. Pick a different model, or check the model card on " +
    "https://build.nvidia.com to see if it requires org-level access."
  );
}

/**
 * Whether the wizard should skip probing the OpenAI Responses API entirely
 * for the given inference provider. NVIDIA Build does not expose
 * `/v1/responses` for any model — every probe to that path returns
 * "404 page not found". Google Gemini also does not support the Responses
 * API. Skipping the probe removes wasted round-trips and stops the
 * failure-message noise from leaking into chat-completions errors.
 * See issue #1601 (Bug 1) and issue #1960.
 */
export function shouldSkipResponsesProbe(provider: string): boolean {
  return provider === "nvidia-prod" || provider === "gemini-api";
}

/**
 * Whether the caller has explicitly requested the chat completions API path.
 * Pass the value of `NEMOCLAW_PREFERRED_API` (or any other source). This lets
 * users with backends that expose `/v1/responses` but lack full streaming-event
 * support (e.g. SGLang) skip the Responses API probe during onboarding.
 */
export function shouldForceCompletionsApi(preferredApi?: string): boolean {
  const value = (preferredApi || "").trim().toLowerCase();
  return value === "openai-completions" || value === "chat-completions";
}
