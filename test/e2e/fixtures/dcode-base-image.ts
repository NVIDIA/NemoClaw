// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DCODE_BASE_IMAGE_ENV = "NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF";
export const DCODE_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";

const IMMUTABLE_DCODE_BASE_IMAGE_REF = new RegExp(
  `^${DCODE_BASE_IMAGE.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`,
  "u",
);

export function requireDcodeBaseImageReference(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const reference = environment[DCODE_BASE_IMAGE_ENV]?.trim() ?? "";
  if (!IMMUTABLE_DCODE_BASE_IMAGE_REF.test(reference)) {
    throw new Error(
      `Deep Agents Code E2E requires ${DCODE_BASE_IMAGE_ENV} to be the immutable official ` +
        `${DCODE_BASE_IMAGE} base image reference with a lowercase SHA-256 digest.`,
    );
  }
  return reference;
}
