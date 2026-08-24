// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildChildEnv } from "./redaction.ts";

const AVAILABILITY_PROBE_EXTRA_ENV_KEYS = [
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "GITHUB_WORKSPACE",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "NEMOCLAW_E2E_EXPECTED_SHA",
  "NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG",
  "NEMOCLAW_OLLAMA_PULL_TIMEOUT",
  "NEMOCLAW_EXPERIMENTAL_PROFILE",
  "NEMOCLAW_RUN_LIVE_E2E",
  "NEMOCLAW_TRACE_DIR",
];

export function buildAvailabilityProbeEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Availability probes run outside live target phases, but they need
  // the same child-env and PATH policy. Add Docker discovery knobs and the
  // workflow-owned local-model pull budget and exact PR catalog authority on
  // top of the shared boundary.
  return buildChildEnv(base, {
    additionalAllowedEnv: AVAILABILITY_PROBE_EXTRA_ENV_KEYS,
    fixtureOverlay: {},
  });
}
