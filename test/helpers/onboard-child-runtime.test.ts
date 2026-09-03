// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { onboardChildRuntimeSource } from "./onboard-child-runtime.js";

type PromptTarget = {
  prompt?: (message: string, options?: { secret?: boolean }) => Promise<string>;
};

type PromptQueueRuntime = {
  installPromptQueue: (
    target: PromptTarget,
    configuredAnswers: readonly string[],
  ) => {
    answers: string[];
    messages: string[];
    prompts: Array<{ message: string; secret: boolean }>;
  };
};

type CaptureResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type ExecutionProofRuntime = {
  createSuccessfulOllamaServiceExecutionProofRunner: (
    fallback?: (command: readonly string[], options: { timeout: number }) => CaptureResult,
  ) => (command: readonly string[], options: { timeout: number }) => CaptureResult;
};

function loadPromptQueueRuntime(): PromptQueueRuntime {
  return new Function(
    `${onboardChildRuntimeSource}\nreturn { installPromptQueue };`,
  )() as PromptQueueRuntime;
}

function loadExecutionProofRuntime(): ExecutionProofRuntime {
  return new Function(
    "require",
    `${onboardChildRuntimeSource}\nreturn { createSuccessfulOllamaServiceExecutionProofRunner };`,
  )(createRequire(import.meta.url)) as ExecutionProofRuntime;
}

describe("onboard child prompt queue", () => {
  it("fails when a child scenario asks an unscripted question", async () => {
    const target: PromptTarget = {};
    const { messages, prompts } = loadPromptQueueRuntime().installPromptQueue(target, ["answer"]);

    assert.ok(target.prompt);
    const prompt = target.prompt;
    assert.equal(await prompt("  Expected question: "), "answer");
    await assert.rejects(
      prompt("  Unexpected question: ", { secret: true }),
      /Unexpected prompt after scripted answers were exhausted:   Unexpected question:/,
    );
    assert.deepEqual(messages, ["  Expected question: ", "  Unexpected question: "]);
    assert.deepEqual(prompts, [
      { message: "  Expected question: ", secret: false },
      { message: "  Unexpected question: ", secret: true },
    ]);
  });
});

describe("onboard child Ollama execution proof runner", () => {
  it("fails an unmatched proof command when the caller omits a fallback (#10663)", () => {
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-proof-runner-"));
    vi.stubEnv("HOME", fixtureHome);
    try {
      const runner =
        loadExecutionProofRuntime().createSuccessfulOllamaServiceExecutionProofRunner();
      const executablePath = path.join(fixtureHome, "ollama-service-exec-fixture");
      const matching = runner(
        [
          "/usr/bin/sudo",
          "-n",
          "/usr/bin/env",
          "LC_ALL=C",
          "/usr/bin/systemd-run",
          "--wait",
          "--pipe",
          "--collect",
          "--service-type=exec",
          "--uid=ollama",
          "--property=KillMode=control-group",
          "--property=RuntimeMaxSec=15s",
          "--property=TimeoutStopSec=250ms",
          "--property=SendSIGKILL=yes",
          executablePath,
          "--version",
        ],
        { timeout: 17_000 },
      );
      const unmatched = runner(["/usr/bin/sudo", "-n", executablePath, "--version"], {
        timeout: 17_000,
      });
      const unrelated = runner(["/usr/bin/systemctl", "restart", "ollama.service"], {
        timeout: 5_000,
      });

      assert.equal(matching.exitCode, 0);
      assert.equal(unmatched.exitCode, 1);
      assert.match(unmatched.stderr, /Unexpected Ollama service execution-proof command/u);
      assert.equal(unrelated.exitCode, 0);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(fixtureHome, { force: true, recursive: true });
    }
  });
});
