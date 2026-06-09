// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildChildEnv } from "../scenarios/orchestrators/redaction.ts";

const AVAILABILITY_PROBE_EXTRA_ENV_KEYS = [
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "XDG_RUNTIME_DIR",
];

export function buildAvailabilityProbeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Availability probes run outside PhaseOrchestrator, but they need the
  // same child-env and PATH policy as scenario steps. Add only Docker
  // discovery knobs on top of the shared framework boundary.
  return buildChildEnv(base, {
    additionalAllowedEnv: AVAILABILITY_PROBE_EXTRA_ENV_KEYS,
    frameworkOverlay: {},
  });
}
