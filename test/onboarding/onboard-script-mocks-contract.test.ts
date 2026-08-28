// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
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

type OnboardScriptMocks = {
  createCreatedSandboxFixture: (options?: {
    gatewayName?: string;
    sandboxName?: string;
  }) => {
    capture: (command: readonly string[]) => string | null;
    create: (command: readonly string[]) => void;
    run: (command: readonly string[]) => CommandResult | null;
    readonly state: { sandboxId: string };
  };
  managedSandboxPolicyReceiptFixture: (
    entry: { name: string },
    options?: { sandboxId?: string },
  ) => { lifecycleLiveIdentityFingerprint: string };
  mockDockerSandboxLifecycleReleaseFromRunner: () => void;
};

const requireForTest = createRequire(import.meta.url);
const fixtureMocks = requireForTest("../helpers/onboard-script-mocks.cjs") as OnboardScriptMocks;
const runner = requireForTest("../../src/lib/runner.ts") as Runner;

describe("shared onboarding process fixture contracts", () => {
  it("uses one stateful identity for creation, list, and get observations (#10463)", () => {
    const fixture = fixtureMocks.createCreatedSandboxFixture({
      gatewayName: "nemoclaw",
      sandboxName: "my-assistant",
    });
    const createAttemptNonce = "a".repeat(62);
    const createAttemptLabel = `ai.nvidia.nemoclaw.create-attempt=${createAttemptNonce}`;
    fixture.create([
      "openshell",
      "sandbox",
      "create",
      "-g",
      "nemoclaw",
      "--label",
      createAttemptLabel,
    ]);
    const createAttemptList = fixture.capture([
      "openshell",
      "sandbox",
      "list",
      "-g",
      "nemoclaw",
      "--selector",
      createAttemptLabel,
      "--output",
      "json",
      "--limit",
      "2",
    ]);
    const sandboxList = fixture.run(["openshell", "sandbox", "list", "-g", "nemoclaw"]);
    const scopedSandboxGet = fixture.capture([
      "openshell",
      "sandbox",
      "get",
      "-g",
      "nemoclaw",
      "my-assistant",
    ]);
    const readinessGet = fixture.run(["openshell", "sandbox", "get", "my-assistant"]);
    const receipt = fixtureMocks.managedSandboxPolicyReceiptFixture(
      { name: "my-assistant" },
      { sandboxId: fixture.state.sandboxId },
    );

    expect(JSON.parse(createAttemptList ?? "[]")).toEqual([
      expect.objectContaining({
        id: fixture.state.sandboxId,
        labels: { "ai.nvidia.nemoclaw.create-attempt": createAttemptNonce },
        name: "my-assistant",
      }),
    ]);
    expect(
      fixture.capture(
        [
          "openshell",
          "sandbox",
          "list",
          "-g",
          "nemoclaw",
          "--selector",
          createAttemptLabel,
          "--output",
          "json",
          "--limit",
          "2",
        ].map((argument) =>
          argument.replace(
            "ai.nvidia.nemoclaw.create-attempt=",
            "aiXnvidiaXnemoclawXcreate-attempt=",
          ),
        ),
      ),
      "the selector label prefix must match literally",
    ).toBeNull();
    expect(String(sandboxList?.stdout)).toContain("my-assistant Ready");
    expect(scopedSandboxGet).toContain(`Id: ${fixture.state.sandboxId}`);
    expect(String(readinessGet?.stdout)).toContain(`Id: ${fixture.state.sandboxId}`);
    expect(receipt.lifecycleLiveIdentityFingerprint).toBe(
      createHash("sha256").update(fixture.state.sandboxId).digest("hex"),
    );
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
