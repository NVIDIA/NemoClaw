// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { qualifyManagedImageActivation } from "./managed-image-activation-e2e-helpers.ts";

const TIMEOUT_MS = 75 * 60_000;

test(
  "candidate CLI activates exact managed images for every shipped agent without a Dockerfile build (#7744)",
  {
    timeout: TIMEOUT_MS,
  },
  async ({ artifacts, cleanup, host, lifecycle, progress, sandbox }) => {
    progress.phase("validate exact candidate catalog and host runtime");

    await artifacts.target.declare({
      id: "managed-image-activation",
      boundary:
        "exact candidate CLI and published all-agent managed-image digests through real Docker, OpenShell, agent turns, gateway restart readiness, and exact cleanup",
      agents: ["openclaw", "hermes", "langchain-deepagents-code"],
      syntheticBoundary:
        "Only the OpenAI-compatible inference response is synthetic; runtime construction and agent execution are real.",
    });
    await qualifyManagedImageActivation({ artifacts, cleanup, host, lifecycle, progress, sandbox });
  },
);
