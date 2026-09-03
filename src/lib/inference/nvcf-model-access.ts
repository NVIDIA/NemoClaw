// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NVIDIA Cloud Functions model-access classification, shared by the host-side
 * onboarding probe and the in-sandbox status invocation probe so both name the
 * same cause for the same HTTP 404.
 */

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
