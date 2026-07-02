// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { AgentDefinition } from "../../agent/defs";
import { runTerminalAgentConnectProbe } from "./terminal-connect-probe";

const dcodeAgent = {
  name: "langchain-deepagents-code",
  runtime: {
    kind: "terminal",
    headless_command: "dcode -n",
    interactive_command: "dcode",
  },
} as AgentDefinition;

describe("terminal-agent connect inference route", () => {
  let errorSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails dcode probe-only before smoke checks when inference.local stays broken (#6191)", () => {
    const capture = vi.fn();
    const ensureInferenceRoute = vi.fn(() => ({ routeHealthy: false }));

    expect(() =>
      runTerminalAgentConnectProbe({
        agent: dcodeAgent,
        agentName: "LangChain Deep Agents Code",
        capture: capture as never,
        ensureInferenceRoute,
        sandboxName: "deep-code",
      }),
    ).toThrow("process.exit(1)");

    expect(ensureInferenceRoute).toHaveBeenCalledWith("deep-code", { quiet: true });
    expect(capture).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "  Probe failed: LangChain Deep Agents Code could not reach the managed inference.local route in 'deep-code'.",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
