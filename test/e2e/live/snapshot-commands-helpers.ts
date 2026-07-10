// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

export interface SnapshotInferenceFixture {
  apiKey: string;
  endpointUrl: string;
  model: string;
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
