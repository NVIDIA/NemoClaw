// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OLLAMA_LOCALHOST,
  setResolvedOllamaHost,
  validateOllamaModel,
} from "./local";

afterEach(() => {
  vi.restoreAllMocks();
  setResolvedOllamaHost(OLLAMA_LOCALHOST);
});

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

  it.each([
    { platform: "linux" as const, systemdUnit: true, recovery: "systemctl" },
    { platform: "darwin" as const, systemdUnit: true, recovery: null },
    { platform: "linux" as const, systemdUnit: false, recovery: "generic" },
  ])(
    "selects recovery for $platform with systemd unit $systemdUnit",
    ({ platform, systemdUnit, recovery }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const result = validateOllamaModel(
        "nemotron-3-nano:30b",
        (command) =>
          systemdUnit && command.some((argument) => argument.includes("systemctl"))
            ? "ollama.service enabled"
            : "",
        () => false,
        () => ({ stdout: "", exitCode: 28, timedOut: true }),
      );
      const message = result.message ?? "";

      expect({
        daemonFailure: result.daemonFailure ?? false,
        generic: message.includes("Restart Ollama and rerun onboarding"),
        ok: result.ok,
        staleRunner: message.includes("Stale runner processes from a previous model"),
        systemctl: message.includes("systemctl"),
      }).toEqual({
        daemonFailure: recovery !== null,
        generic: recovery === "generic",
        ok: false,
        staleRunner: recovery !== null,
        systemctl: recovery === "systemctl",
      });
    },
  );

  it("reports a fast retry failure from the final probe result", () => {
    let callCount = 0;
    const result = validateOllamaModel(
      "nemotron-3-nano:30b",
      () => "",
      () => false,
      () => {
        callCount += 1;
        return callCount === 1
          ? { stdout: "", exitCode: 28, timedOut: true }
          : { stdout: "", exitCode: 7, timedOut: false };
      },
    );

    expect({ daemonFailure: result.daemonFailure, message: result.message }).toEqual({
      daemonFailure: undefined,
      message: expect.stringMatching(/^Selected Ollama model .* failed the local probe/),
    });
  });
});
