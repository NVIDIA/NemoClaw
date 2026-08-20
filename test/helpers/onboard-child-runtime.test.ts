// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "vitest";
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

function loadPromptQueueRuntime(): PromptQueueRuntime {
  return new Function(
    `${onboardChildRuntimeSource}\nreturn { installPromptQueue };`,
  )() as PromptQueueRuntime;
}

describe("onboard child prompt queue", () => {
  it("fails when a child scenario asks an unscripted question", async () => {
    const target: PromptTarget = {};
    const { messages, prompts } = loadPromptQueueRuntime().installPromptQueue(target, []);

    assert.ok(target.prompt);
    await assert.rejects(
      target.prompt("  Unexpected question: ", { secret: true }),
      /Unexpected prompt after scripted answers were exhausted:   Unexpected question:/,
    );
    assert.deepEqual(messages, ["  Unexpected question: "]);
    assert.deepEqual(prompts, [{ message: "  Unexpected question: ", secret: true }]);
  });
});
