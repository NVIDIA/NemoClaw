// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ONBOARD_CREATED_SANDBOX_ID, writeOkOpenshell } from "../helpers/onboard-openshell-fixture";

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
  ONBOARD_CREATED_SANDBOX_ID: string;
  createStatefulMessagingProviderRunner: (options: {
    commands: Array<{ command: string }>;
    readySandboxName: string;
  }) => (command: readonly string[]) => CommandResult;
  managedSandboxPolicyReceiptFixture: (
    entry: { name: string },
    options?: { sandboxId?: string },
  ) => { lifecycleLiveIdentityFingerprint: string };
  mockCreatedSandboxIdentityList: (
    command: readonly string[],
    options?: { sandboxName?: string; sandboxId?: string },
  ) => string | null;
  mockDockerSandboxLifecycleReleaseFromRunner: () => void;
};

const requireForTest = createRequire(import.meta.url);
const fixtureMocks = requireForTest("../helpers/onboard-script-mocks.cjs") as OnboardScriptMocks;
const runner = requireForTest("../../src/lib/runner.ts") as Runner;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("shared onboarding process fixture contracts", () => {
  it("uses one durable sandbox ID across create discovery and structured OpenShell probes", () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), "nemoclaw-onboard-fixture-contract-"));
    temporaryDirectories.push(fakeRoot);
    const fakeBin = join(fakeRoot, "bin");
    mkdirSync(fakeBin);
    writeOkOpenshell(fakeBin, { readySandboxGet: true });

    const createAttemptNonce = "a".repeat(62);
    const createAttemptCommand = [
      "openshell",
      "sandbox",
      "list",
      "-g",
      "nemoclaw",
      "--selector",
      `ai.nvidia.nemoclaw.create-attempt=${createAttemptNonce}`,
      "--output",
      "json",
      "--limit",
      "2",
    ];
    const createAttemptList = fixtureMocks.mockCreatedSandboxIdentityList(createAttemptCommand);
    const sandboxGet = spawnSync(
      join(fakeBin, "openshell"),
      ["sandbox", "get", "-g", "nemoclaw", "my-assistant"],
      {
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
    );
    const receipt = fixtureMocks.managedSandboxPolicyReceiptFixture({ name: "my-assistant" });
    const messagingRunner = fixtureMocks.createStatefulMessagingProviderRunner({
      commands: [],
      readySandboxName: "my-assistant",
    });
    const messagingGet = messagingRunner([
      "openshell",
      "sandbox",
      "get",
      "-g",
      "nemoclaw",
      "my-assistant",
    ]);

    expect(fixtureMocks.ONBOARD_CREATED_SANDBOX_ID).toBe(ONBOARD_CREATED_SANDBOX_ID);
    expect(JSON.parse(createAttemptList ?? "[]")).toEqual([
      expect.objectContaining({
        id: ONBOARD_CREATED_SANDBOX_ID,
        labels: { "ai.nvidia.nemoclaw.create-attempt": createAttemptNonce },
        name: "my-assistant",
      }),
    ]);
    expect(
      fixtureMocks.mockCreatedSandboxIdentityList(
        createAttemptCommand.map((argument) =>
          argument.replace(
            "ai.nvidia.nemoclaw.create-attempt=",
            "aiXnvidiaXnemoclawXcreate-attempt=",
          ),
        ),
      ),
      "the selector label prefix must match literally",
    ).toBeNull();
    expect(sandboxGet.status, sandboxGet.stderr).toBe(0);
    expect(sandboxGet.stdout).toContain(`Id: ${ONBOARD_CREATED_SANDBOX_ID}`);
    expect(String(messagingGet.stdout)).toContain(`Id: ${ONBOARD_CREATED_SANDBOX_ID}`);
    expect(receipt.lifecycleLiveIdentityFingerprint).toBe(
      createHash("sha256").update(ONBOARD_CREATED_SANDBOX_ID).digest("hex"),
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
