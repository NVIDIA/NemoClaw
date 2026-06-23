// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-owned inventories for the temporary NVIDIA_API_KEY compatibility
 * alias.
 *
 * Invalid state: several Vitest live lanes and a small number of reusable shell
 * E2E scripts still read NVIDIA_API_KEY directly even though hosted CI inference
 * is now canonicalized as NVIDIA_INFERENCE_API_KEY and COMPATIBLE_API_KEY. Until
 * those lanes migrate, only the jobs listed here may receive the compatibility
 * alias. All other hosted-inference steps should receive only
 * NVIDIA_INFERENCE_API_KEY and COMPATIBLE_API_KEY.
 *
 * Removal condition: delete these inventories, the nvidia-api-key and
 * export-nvidia-api-key action inputs, e2e-script.yaml's nvidia_api_key_alias
 * input, and workflow NVIDIA_API_KEY exports after every listed lane either
 * migrates to NVIDIA_INFERENCE_API_KEY or documents an explicit public-endpoint
 * credential requirement that is not a compatibility alias.
 */
export const HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_JOBS = [
  "openclaw-skill-cli-vitest",
  "cloud-inference-vitest",
  "sessions-agents-cli-vitest",
  "common-egress-agent-vitest",
  "state-backup-restore-vitest",
  "messaging-providers-vitest",
  "snapshot-commands-vitest",
  "diagnostics-vitest",
  "openclaw-inference-switch-vitest",
  "channels-add-remove-vitest",
] as const;

export type HostedInferenceLegacyNvidiaApiKeyJob =
  (typeof HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_JOBS)[number];

export const HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_JOB_SET: ReadonlySet<string> = new Set(
  HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_JOBS,
);

export const HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_SCRIPT_JOBS = [
  "messaging-providers-e2e",
  "hermes-discord-e2e",
] as const;

export type HostedInferenceLegacyNvidiaApiKeyScriptJob =
  (typeof HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_SCRIPT_JOBS)[number];

export const HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_SCRIPT_JOB_SET: ReadonlySet<string> = new Set(
  HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_SCRIPT_JOBS,
);

export const HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_VITEST_JOBS = [
  "credential-migration-vitest",
] as const;

export type HostedInferencePublicNvidiaFallbackVitestJob =
  (typeof HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_VITEST_JOBS)[number];

export const HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_VITEST_JOB_SET: ReadonlySet<string> =
  new Set(HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_VITEST_JOBS);

export const HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_SCRIPT_JOBS = [
  "cloud-inference-e2e",
  ...HOSTED_INFERENCE_LEGACY_NVIDIA_API_KEY_SCRIPT_JOBS,
] as const;

export type HostedInferencePublicNvidiaFallbackScriptJob =
  (typeof HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_SCRIPT_JOBS)[number];

export const HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_SCRIPT_JOB_SET: ReadonlySet<string> = new Set(
  HOSTED_INFERENCE_PUBLIC_NVIDIA_FALLBACK_SCRIPT_JOBS,
);
