// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { qualifyManagedImageActivation } from "./managed-image-activation-e2e-helpers.ts";

const TIMEOUT_MS = 75 * 60_000;

test(
  "candidate CLI activates exact managed images for every shipped agent without a Dockerfile build (#7744)",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate exact candidate catalog and host runtime",
        "onboard and exercise OpenClaw",
        "stop and start OpenClaw through public NemoClaw lifecycle",
        "destroy and verify OpenClaw cleanup",
        "onboard and exercise Hermes",
        "prove Hermes secret-boundary refusal before native restart",
        "stop and start Hermes through public NemoClaw lifecycle",
        "destroy and verify Hermes cleanup",
        "onboard and exercise Deep Agents Code",
        "stop and start Deep Agents Code through public NemoClaw lifecycle",
        "destroy and verify Deep Agents Code cleanup",
        "prove buildless all-agent activation",
      ],
    },
  },
  async ({ artifacts, cleanup, host, lifecycle, progress, sandbox }) => {
    const containerEngine = process.env.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "Podman" : "Docker";
    await artifacts.target.declare({
      id: "managed-image-activation",
      boundary: `exact candidate CLI and published all-agent managed-image digests through real ${containerEngine}, OpenShell, agent turns, gateway restart readiness, and exact cleanup`,
      agents: ["openclaw", "hermes", "langchain-deepagents-code"],
      syntheticBoundary:
        "Only the OpenAI-compatible inference response is synthetic; runtime construction and agent execution are real.",
    });
    await qualifyManagedImageActivation({ artifacts, cleanup, host, lifecycle, progress, sandbox });
  },
);
