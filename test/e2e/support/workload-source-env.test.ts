// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveLiveE2eWorkloadSourceEnv } from "../fixtures/workload-source-env.ts";

describe("live E2E workload source environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["openclaw", "Dockerfile"],
    ["hermes", "agents/hermes/Dockerfile"],
    ["langchain-deepagents-code", "agents/langchain-deepagents-code/Dockerfile"],
    ["pi", "agents/pi/Dockerfile"],
  ])("uses the candidate Dockerfile for %s", (agent, dockerfile) => {
    expect(
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: "full-e2e",
        E2E_WORKLOAD_SOURCE: "local-dockerfile",
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

  it("inherits the workflow source decision at the child command boundary", () => {
    vi.stubEnv("E2E_TARGET_ID", "hermes-e2e");
    vi.stubEnv("E2E_WORKLOAD_SOURCE", "local-dockerfile");
    vi.stubEnv("NEMOCLAW_AGENT", "hermes");

    expect(resolveLiveE2eWorkloadSourceEnv({})).toEqual({
      NEMOCLAW_FROM_DOCKERFILE: path.join(REPO_ROOT, "agents/hermes/Dockerfile"),
    });
  });

  it("honors the managed-image source", () => {
    const input = {
      E2E_TARGET_ID: "managed-image-protected-runtime",
      E2E_WORKLOAD_SOURCE: "managed-image",
    };
    expect(resolveLiveE2eWorkloadSourceEnv(input)).toEqual(input);
  });
});
