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
