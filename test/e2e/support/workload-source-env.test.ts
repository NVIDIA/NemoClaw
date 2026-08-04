// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveLiveE2eWorkloadSourceEnv } from "../fixtures/workload-source-env.ts";

describe("live E2E workload source environment", () => {
  it.each([
    ["openclaw", "agents/openclaw/Dockerfile"],
    ["hermes", "agents/hermes/Dockerfile"],
    ["langchain-deepagents-code", "agents/langchain-deepagents-code/Dockerfile"],
  ])("keeps legacy %s targets on their existing Dockerfile coverage", (agent, dockerfile) => {
    expect(
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: "full-e2e",
        NEMOCLAW_AGENT: agent,
      }),
    ).toMatchObject({
      NEMOCLAW_FROM_DOCKERFILE: path.join(REPO_ROOT, dockerfile),
    });
  });

  it.each([
    "managed-image-protected-runtime",
    "podman-native-cpu",
    "mxc-runtime-proof",
  ])("leaves native managed-image target %s buildless", (targetId) => {
    expect(resolveLiveE2eWorkloadSourceEnv({ E2E_TARGET_ID: targetId })).toEqual({
      E2E_TARGET_ID: targetId,
    });
  });

  it("honors an explicit managed-image source on a legacy-named target", () => {
    expect(
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: "full-e2e",
        E2E_WORKLOAD_SOURCE: "managed-image",
      }),
    ).toEqual({
      E2E_TARGET_ID: "full-e2e",
      E2E_WORKLOAD_SOURCE: "managed-image",
    });
  });
});
