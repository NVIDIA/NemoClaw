// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseTrustedPrivateHosts } from "../security/trusted-private-endpoint";

export * from "../security/trusted-private-endpoint";
export { parseTrustedPrivateHosts as parseTrustedPrivateInferenceHosts } from "../security/trusted-private-endpoint";

/** Read the generic trust source and the legacy inference-only source. */
export function parseTrustedPrivateInferenceHostsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set([
      ...parseTrustedPrivateHosts(env.NEMOCLAW_TRUSTED_PRIVATE_HOSTS),
      ...parseTrustedPrivateHosts(env.NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS),
    ]),
  ];
}
