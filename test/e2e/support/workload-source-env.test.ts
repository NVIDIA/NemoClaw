// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveLiveE2eWorkloadSourceEnv } from "../fixtures/workload-source-env.ts";

describe("live E2E workload source environment", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "rejects automatic legacy-Dockerfile selection for %s",
    (agent) => {
      expect(() =>
        resolveLiveE2eWorkloadSourceEnv({
          E2E_TARGET_ID: "full-e2e",
          E2E_WORKLOAD_SOURCE: "legacy-dockerfile",
          NEMOCLAW_AGENT: agent,
        }),
      ).toThrow("cannot select a stock legacy Dockerfile");
    },
  );

  it("preserves an explicit custom Dockerfile", () => {
    const input = {
      E2E_TARGET_ID: "custom-dockerfile",
      E2E_WORKLOAD_SOURCE: "legacy-dockerfile",
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_FROM_DOCKERFILE: "/workspace/CustomDockerfile",
    };
    expect(resolveLiveE2eWorkloadSourceEnv(input)).toEqual(input);
  });

  it("leaves an unspecified source on the product's default workload path", () => {
    const input = { E2E_TARGET_ID: "full-e2e", NEMOCLAW_AGENT: "openclaw" };
    expect(resolveLiveE2eWorkloadSourceEnv(input)).toEqual(input);
  });

  it("honors the provider-neutral managed-image source", () => {
    const targetId = "managed-image-protected-runtime";
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
