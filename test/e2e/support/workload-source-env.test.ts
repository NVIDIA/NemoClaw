// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveLiveE2eWorkloadSourceEnv } from "../fixtures/workload-source-env.ts";

describe("live E2E workload source environment", () => {
  it.each([
    ["openclaw", "Dockerfile"],
    ["hermes", "agents/hermes/Dockerfile"],
    ["langchain-deepagents-code", "agents/langchain-deepagents-code/Dockerfile"],
  ])("honors the explicit legacy-Dockerfile source for %s", (agent, dockerfile) => {
    expect(
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: "full-e2e",
        E2E_WORKLOAD_SOURCE: "legacy-dockerfile",
        NEMOCLAW_AGENT: agent,
      }),
    ).toMatchObject({
      NEMOCLAW_FROM_DOCKERFILE: path.join(REPO_ROOT, dockerfile),
    });
  });

  it("leaves an unspecified source on the product's default workload path", () => {
    const input = { E2E_TARGET_ID: "full-e2e", NEMOCLAW_AGENT: "openclaw" };
    expect(resolveLiveE2eWorkloadSourceEnv(input)).toEqual(input);
  });

  it.each([
    "managed-image-protected-runtime",
    "podman-native-cpu",
    "mxc-runtime-proof",
  ])("honors the provider-neutral managed-image source for %s", (targetId) => {
    expect(
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: targetId,
        E2E_WORKLOAD_SOURCE: "managed-image",
      }),
    ).toEqual({
      E2E_TARGET_ID: targetId,
      E2E_WORKLOAD_SOURCE: "managed-image",
    });
  });
});
