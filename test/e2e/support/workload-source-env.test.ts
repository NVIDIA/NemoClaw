// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENTS_DIR } from "../../../src/lib/agent/defs.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveLiveE2eWorkloadSourceEnv } from "../fixtures/workload-source-env.ts";

describe("live E2E workload source environment", () => {
  const temporaryAgentDirectories: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (temporaryAgentDirectories.length > 0) {
      fs.rmSync(temporaryAgentDirectories.pop() ?? "", { force: true, recursive: true });
    }
  });

  it.each([
    ["openclaw", "Dockerfile"],
    ["hermes", "agents/hermes/Dockerfile"],
    ["langchain-deepagents-code", "agents/langchain-deepagents-code/Dockerfile"],
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

  it("uses the qualified Pi candidate Dockerfile", () => {
    expect(
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: "pi-agent-qualification",
        E2E_WORKLOAD_SOURCE: "local-dockerfile",
        NEMOCLAW_AGENT: "pi",
        NEMOCLAW_CANDIDATE_AGENTS: "1",
        NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT: path.join(
          REPO_ROOT,
          "ci/pi-agent-qualification-v1-linux-amd64.json",
        ),
      }),
    ).toMatchObject({
      NEMOCLAW_FROM_DOCKERFILE: path.join(REPO_ROOT, "agents/pi/Dockerfile"),
    });
  });

  it("rejects an unknown local-build agent", () => {
    expect(() =>
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: "full-e2e",
        E2E_WORKLOAD_SOURCE: "local-dockerfile",
        NEMOCLAW_AGENT: "not-an-agent",
      }),
    ).toThrow("Agent 'not-an-agent' not found");
  });

  it("rejects a selected agent without a Dockerfile", () => {
    const agentDirectory = fs.mkdtempSync(path.join(AGENTS_DIR, "e2e-no-dockerfile-"));
    temporaryAgentDirectories.push(agentDirectory);
    const agentName = path.basename(agentDirectory);
    fs.writeFileSync(
      path.join(agentDirectory, "manifest.yaml"),
      `name: ${agentName}\ndisplay_name: E2E no Dockerfile\n`,
    );

    expect(() =>
      resolveLiveE2eWorkloadSourceEnv({
        E2E_TARGET_ID: "full-e2e",
        E2E_WORKLOAD_SOURCE: "local-dockerfile",
        NEMOCLAW_AGENT: agentName,
      }),
    ).toThrow(`Agent '${agentName}' has no Dockerfile for local E2E workload source.`);
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
