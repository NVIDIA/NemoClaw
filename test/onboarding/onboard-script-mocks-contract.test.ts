// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type CommandResult = {
  status: number;
  stdout?: Buffer;
  stderr?: Buffer;
};

type Runner = {
  run: (command: readonly string[], options?: Record<string, unknown>) => CommandResult;
  runCapture: (command: readonly string[], options?: Record<string, unknown>) => string;
};

type ProviderCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

type OnboardScriptMocks = {
  mockDockerSandboxLifecycleReleaseFromRunner: () => void;
  mockNvidiaOrMissingProviderGetRun: (
    command: readonly string[],
    gatewayName: string,
  ) => ProviderCommandResult | null;
  mockNvidiaProviderGetRun: (
    command: readonly string[],
    gatewayName: string,
  ) => ProviderCommandResult | null;
};

const requireForTest = createRequire(import.meta.url);
const fixtureMocks = requireForTest("../helpers/onboard-script-mocks.cjs") as OnboardScriptMocks;
const runner = requireForTest("../../src/lib/runner.ts") as Runner;

describe("shared onboarding process fixture contracts", () => {
  it.each([
    ["omitted", ["openshell", "provider", "get", "nvidia-prod"]],
    ["incorrect", ["openshell", "provider", "get", "-g", "other", "nvidia-prod"]],
  ])("rejects an %s provider get gateway", (_label, command) => {
    const expected = {
      status: 1,
      stderr: "provider get must target named gateway 'nemoclaw'",
    };

    expect(fixtureMocks.mockNvidiaProviderGetRun(command, "nemoclaw")).toEqual(expected);
    expect(fixtureMocks.mockNvidiaOrMissingProviderGetRun(command, "nemoclaw")).toEqual(expected);
  });

  it("accepts only an exact named-gateway provider get", () => {
    const command = ["openshell", "provider", "get", "-g", "nemoclaw", "nvidia-prod"];

    expect(fixtureMocks.mockNvidiaProviderGetRun(command, "nemoclaw")).toEqual({
      status: 0,
      stdout:
        "Name: nvidia-prod\nType: nvidia\nCredential keys: NVIDIA_INFERENCE_API_KEY\nConfig keys: <none>\n",
    });
  });

  it("composes Docker lifecycle state across run and runCapture", () => {
    const originalRun = runner.run;
    const originalRunCapture = runner.runCapture;
    const readyList = "my-assistant  2026-08-27  Ready\n";
    const listCommand = ["openshell", "sandbox", "list"];
    runner.run = () => ({
      status: 0,
      stdout: Buffer.from(readyList),
      stderr: Buffer.alloc(0),
    });
    runner.runCapture = () => readyList;

    try {
      fixtureMocks.mockDockerSandboxLifecycleReleaseFromRunner();
      const oldContainerId = "a".repeat(64);
      const newContainerId = "b".repeat(64);
      const containerListCommand = [
        "docker",
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/sandbox-name=my-assistant",
        "--format",
        "{{.ID}}",
      ];

      expect(runner.runCapture(listCommand)).toBe(readyList);
      expect(runner.run(["docker", "rm", oldContainerId]).status).toBe(0);
      expect(String(runner.run(containerListCommand).stdout)).toBe(`${newContainerId}\n`);
      expect(runner.runCapture(containerListCommand)).toBe(`${newContainerId}\n`);

      expect(runner.run(["openshell", "sandbox", "stop", "my-assistant"]).status).toBe(0);
      expect(String(runner.run(listCommand).stdout)).toContain("Stopped");
      expect(runner.runCapture(listCommand)).toContain("Stopped");

      expect(runner.run(["openshell", "sandbox", "start", "my-assistant"]).status).toBe(0);
      expect(String(runner.run(listCommand).stdout)).toContain("Ready");
      expect(runner.runCapture(listCommand)).toContain("Ready");
    } finally {
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
    }
  });
});
