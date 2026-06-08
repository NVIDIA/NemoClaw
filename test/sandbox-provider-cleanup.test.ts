// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  SANDBOX_PROVIDER_SUFFIXES,
  detachSandboxProviders,
} from "../dist/lib/onboard/sandbox-provider-cleanup.js";

type Argv = string[];

function buildRunOpenshell(
  responses: Map<string, { status: number | null; stderr?: string; stdout?: string }>,
  defaultResponse: { status: number | null; stderr?: string; stdout?: string } = { status: 0 },
) {
  const calls: Argv[] = [];
  const fn = vi.fn((args: Argv) => {
    calls.push(args);
    const key = args.join(" ");
    return responses.get(key) ?? defaultResponse;
  });
  return { runOpenshell: fn, calls };
}

describe("SANDBOX_PROVIDER_SUFFIXES", () => {
  it("covers the full set of per-sandbox messaging and search providers", () => {
    expect(SANDBOX_PROVIDER_SUFFIXES).toEqual([
      "telegram-bridge",
      "discord-bridge",
      "slack-bridge",
      "slack-app",
      "wechat-bridge",
      "brave-search",
    ]);
  });
});

describe("detachSandboxProviders", () => {
  it("issues 'sandbox provider detach' for every suffix in the shared set", () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    const result = detachSandboxProviders("spark-nemo", { runOpenshell });

    const detachCalls = calls.filter(
      (argv) => argv[0] === "sandbox" && argv[1] === "provider" && argv[2] === "detach",
    );
    expect(detachCalls).toEqual([
      ["sandbox", "provider", "detach", "spark-nemo", "spark-nemo-telegram-bridge"],
      ["sandbox", "provider", "detach", "spark-nemo", "spark-nemo-discord-bridge"],
      ["sandbox", "provider", "detach", "spark-nemo", "spark-nemo-slack-bridge"],
      ["sandbox", "provider", "detach", "spark-nemo", "spark-nemo-slack-app"],
      ["sandbox", "provider", "detach", "spark-nemo", "spark-nemo-wechat-bridge"],
      ["sandbox", "provider", "detach", "spark-nemo", "spark-nemo-brave-search"],
    ]);
    expect(result.detached).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(result.failures).toEqual([]);
  });

  it("treats NotFound / not attached outputs as success-equivalent", () => {
    const responses = new Map<string, { status: number; stderr?: string }>([
      [
        "sandbox provider detach alpha alpha-telegram-bridge",
        { status: 1, stderr: "Error: status: NotFound, provider 'alpha-telegram-bridge' not found" },
      ],
      [
        "sandbox provider detach alpha alpha-brave-search",
        { status: 2, stderr: "provider not attached to sandbox" },
      ],
    ]);
    const { runOpenshell } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("alpha", { runOpenshell });

    expect(result.failures).toEqual([]);
    expect(result.detached).toContain("alpha-discord-bridge");
    expect(result.detached).not.toContain("alpha-telegram-bridge");
    expect(result.detached).not.toContain("alpha-brave-search");
  });

  it("collects non-tolerated failures without aborting the loop", () => {
    const responses = new Map<string, { status: number; stderr?: string }>([
      [
        "sandbox provider detach beta beta-telegram-bridge",
        { status: 1, stderr: "Error: status: Internal, gateway timeout" },
      ],
    ]);
    const { runOpenshell, calls } = buildRunOpenshell(responses);

    const result = detachSandboxProviders("beta", { runOpenshell });

    const detachCalls = calls.filter(
      (argv) => argv[0] === "sandbox" && argv[1] === "provider" && argv[2] === "detach",
    );
    expect(detachCalls).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length);
    expect(result.failures).toEqual([
      { name: "beta-telegram-bridge", output: "Error: status: Internal, gateway timeout" },
    ]);
    expect(result.detached).toHaveLength(SANDBOX_PROVIDER_SUFFIXES.length - 1);
  });

  it("includes the Brave search provider in the detach set", () => {
    const { runOpenshell, calls } = buildRunOpenshell(new Map());

    detachSandboxProviders("spark-nemo", { runOpenshell });

    const braveCall = calls.find(
      (argv) =>
        argv[0] === "sandbox" &&
        argv[1] === "provider" &&
        argv[2] === "detach" &&
        argv[4] === "spark-nemo-brave-search",
    );
    expect(braveCall).toBeDefined();
  });
});
