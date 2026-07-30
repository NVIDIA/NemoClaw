// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

export interface SnapshotInferenceFixture {
  apiKey: string;
  endpointUrl: string;
  model: string;
}

export type SnapshotGatewayProbeClassification =
  | "authenticated"
  | "command-failure"
  | "empty-output"
  | "embedded-fallback"
  | "gateway-connect-failure"
  | "scope-upgrade-pending"
  | "device-pairing-required";
export type SnapshotRestoreResultClassification =
  | "restored"
  | "restored-pairing-unverified"
  | "command-failure"
  | "missing-restored-marker";

const SNAPSHOT_GATEWAY_PROBE_REJECTIONS: ReadonlyArray<{
  pattern: RegExp;
  classification: SnapshotGatewayProbeClassification;
}> = [
  {
    pattern: /scope upgrade pending approval|pairing required: device is asking for more scopes/i,
    classification: "scope-upgrade-pending",
  },
  {
    pattern: /device pairing required|pairing required/i,
    classification: "device-pairing-required",
  },
  {
    pattern: /gateway connect failed/i,
    classification: "gateway-connect-failure",
  },
  {
    pattern: /EMBEDDED FALLBACK|fallbackFrom[": ]+gateway|transport[": ]+embedded/i,
    classification: "embedded-fallback",
  },
];

export function classifySnapshotGatewayProbe(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): SnapshotGatewayProbeClassification {
  const output = `${result.stdout}\n${result.stderr}`;
  const rejection = SNAPSHOT_GATEWAY_PROBE_REJECTIONS.find(({ pattern }) => pattern.test(output));
  if (rejection) return rejection.classification;
  if (result.exitCode !== 0) return "command-failure";
  if (!output.trim()) return "empty-output";
  return "authenticated";
}
export function classifySnapshotRestoreResult(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): SnapshotRestoreResultClassification {
  const output = `${result.stdout}\n${result.stderr}`;
  if (
    result.exitCode !== null &&
    result.exitCode !== 0 &&
    /\bState restored into\b/.test(output) &&
    /gateway pairing could not be verified/i.test(output)
  ) {
    return "restored-pairing-unverified";
  }
  if (result.exitCode !== 0) return "command-failure";
  return /\bRestored\b/.test(output) ? "restored" : "missing-restored-marker";
}

/**
 * Builds the child env for the snapshot-commands live target.
 *
 * `NEMOCLAW_E2E_USE_HOSTED_INFERENCE` is in the fixture env allowlist, so an
 * ambient value is forwarded into the child. `stageHostedInferenceSourceSecretEnv`
 * treats that flag alone as sufficient to force hosted-custom staging even when
 * `COMPATIBLE_API_KEY` names an explicit endpoint, which would silently route
 * this target back at hosted inference. Strip it so the target stays hermetic.
 */
export function buildSnapshotCommandEnv(
  sandboxName: string,
  inference?: SnapshotInferenceFixture,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  delete env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE;
  if (inference) {
    Object.assign(env, {
      COMPATIBLE_API_KEY: inference.apiKey,
      NEMOCLAW_COMPAT_MODEL: inference.model,
      NEMOCLAW_ENDPOINT_URL: inference.endpointUrl,
      NEMOCLAW_MODEL: inference.model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    });
  }
  return env;
}
