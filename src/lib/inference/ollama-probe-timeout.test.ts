// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateOllamaModel } from "./local";

describe("Ollama probe timeout retry", () => {
  it("retries with extended timeout on non-Spark hosts when first probe times out", () => {
    const commands: string[] = [];
    let captureExCallCount = 0;
    const captureEx = (cmd: string[]) => {
      captureExCallCount++;
      commands.push(cmd.join(" "));
      if (captureExCallCount === 1) return { stdout: "", exitCode: 28, timedOut: true };
      return { stdout: JSON.stringify({ response: "Hi" }), exitCode: 0, timedOut: false };
    };

    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => "",
      () => false,
      captureEx,
    );

    expect(result.ok).toBe(true);
    expect(captureExCallCount).toBe(2);
    expect(commands[1]).toMatch(/--max-time.*300|300.*--max-time/);
  });

  it("prints stale-runner recovery when both bounded probes time out", () => {
    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => "",
      () => false,
      () => ({ stdout: "", exitCode: 28, timedOut: true }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("Stale runner processes from a previous model");
    expect(result.message).toContain("sudo systemctl restart ollama");
  });
});
