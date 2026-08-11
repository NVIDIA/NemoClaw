// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { qualifyManagedImageActivation } from "./managed-image-activation-e2e-helpers.ts";

const TIMEOUT_MS = 75 * 60_000;

test("CLI activates exact managed images for every shipped agent without a Dockerfile build (#7744)", {
  timeout: TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "validate exact managed image catalog and host runtime",
      "onboard and exercise OpenClaw",
      "restart and recover OpenClaw",
      "destroy and verify OpenClaw cleanup",
      "onboard and exercise Hermes",
      "restart and recover Hermes",
      "destroy and verify Hermes cleanup",
      "onboard and exercise Deep Agents Code",
      "restart and recover Deep Agents Code",
      "destroy and verify Deep Agents Code cleanup",
      "prove buildless all-agent activation",
    ],
  },
}, async ({ artifacts, cleanup, host, lifecycle, progress, sandbox }) => {
  await artifacts.target.declare({
    id: "managed-image-activation",
    boundary:
      "CLI and published managed-image digests for all shipped agents through real Docker, OpenShell, agent turns, restart recovery, and exact cleanup",
    agents: ["openclaw", "hermes", "langchain-deepagents-code"],
    syntheticBoundary:
      "Only the OpenAI-compatible inference response is synthetic; runtime construction and agent execution are real.",
  });
  await qualifyManagedImageActivation({ artifacts, cleanup, host, lifecycle, progress, sandbox });
});
