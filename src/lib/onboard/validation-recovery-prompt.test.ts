// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { createValidationRecoveryPromptHelpers } from "./validation-recovery-prompt";

const CREDENTIAL_RECOVERY = { kind: "credential", retry: "credential" } as const;

function createRecoveryPrompt(answers: string[]) {
  const prompt = vi.fn(async () => {
    const answer = answers.shift();
    expect(answer, "Unexpected prompt call").toBeDefined();
    return answer ?? "";
  });
  const exitError = Object.assign(new Error("onboard exit"), { exitCode: 0 });
  const helpers = createValidationRecoveryPromptHelpers({
    isNonInteractive: () => false,
    prompt,
    validateNvidiaApiKeyValue: () => null,
    getTransportRecoveryMessage: () => "  Transport failed.",
    exitOnboardFromPrompt(): never {
      throw exitError;
    },
  });

  return { exitError, helpers, prompt };
}

function expectCredentialPromptWasSecret(
  prompt: ReturnType<typeof createRecoveryPrompt>["prompt"],
) {
  expect(prompt).toHaveBeenCalledWith("  OpenAI API key: ", { secret: true });
}

function expectHelpBeforeSelectionReturn(log: MockInstance<typeof console.log>) {
  const messages = log.mock.calls.map(([message]) => message);
  expect(
    messages.indexOf("  Type back to choose a different provider, or exit to quit."),
  ).toBeLessThan(messages.indexOf("  Returning to provider selection."));
}

describe("validation recovery credential prompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns to provider selection when the re-entry prompt receives back (#9557)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers, prompt } = createRecoveryPrompt(["retry", "back"]);

    await expect(
      helpers.promptValidationRecovery("OpenAI", CREDENTIAL_RECOVERY, "OPENAI_API_KEY"),
    ).resolves.toBe("selection");

    expect(process.env.OPENAI_API_KEY).toBe("sk-bad");
    expectCredentialPromptWasSecret(prompt);
    expect(log).toHaveBeenCalledWith("  Returning to provider selection.");
  });

  it("stages selection when the re-entry prompt receives selection as a credential (#9557)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers, prompt } = createRecoveryPrompt(["retry", "selection"]);

    await expect(
      helpers.promptValidationRecovery("OpenAI", CREDENTIAL_RECOVERY, "OPENAI_API_KEY"),
    ).resolves.toBe("credential");

    expect(process.env.OPENAI_API_KEY).toBe("selection");
    expectCredentialPromptWasSecret(prompt);
  });

  it("returns to provider selection from the paste-guard re-entry path (#9557)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers, prompt } = createRecoveryPrompt(["sk-pasted", "back"]);

    await expect(
      helpers.promptValidationRecovery("OpenAI", CREDENTIAL_RECOVERY, "OPENAI_API_KEY"),
    ).resolves.toBe("selection");

    expect(process.env.OPENAI_API_KEY).toBe("sk-bad");
    expectCredentialPromptWasSecret(prompt);
    expect(log).toHaveBeenCalledWith("  Returning to provider selection.");
  });

  it("exits onboarding when the re-entry prompt receives exit (#9557)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { exitError, helpers, prompt } = createRecoveryPrompt(["retry", "exit"]);

    await expect(
      helpers.promptValidationRecovery("OpenAI", CREDENTIAL_RECOVERY, "OPENAI_API_KEY"),
    ).rejects.toBe(exitError);

    expect(process.env.OPENAI_API_KEY).toBe("sk-bad");
    expectCredentialPromptWasSecret(prompt);
  });

  it("exits onboarding when the re-entry prompt receives quit (#9557)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { exitError, helpers, prompt } = createRecoveryPrompt(["retry", "quit"]);

    await expect(
      helpers.promptValidationRecovery("OpenAI", CREDENTIAL_RECOVERY, "OPENAI_API_KEY"),
    ).rejects.toBe(exitError);

    expect(process.env.OPENAI_API_KEY).toBe("sk-bad");
    expectCredentialPromptWasSecret(prompt);
  });

  it("prints credential prompt help before accepting back at re-entry (#9557)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers, prompt } = createRecoveryPrompt(["retry", "?", "back"]);

    await expect(
      helpers.promptValidationRecovery("OpenAI", CREDENTIAL_RECOVERY, "OPENAI_API_KEY"),
    ).resolves.toBe("selection");

    expect(process.env.OPENAI_API_KEY).toBe("sk-bad");
    expectCredentialPromptWasSecret(prompt);
    expect(log).toHaveBeenCalledWith(
      "  Type back to choose a different provider, or exit to quit.",
    );
    expectHelpBeforeSelectionReturn(log);
  });

  it("prints credential prompt help for the help alias before accepting back (#9557)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers, prompt } = createRecoveryPrompt(["retry", "help", "back"]);

    await expect(
      helpers.promptValidationRecovery("OpenAI", CREDENTIAL_RECOVERY, "OPENAI_API_KEY"),
    ).resolves.toBe("selection");

    expect(process.env.OPENAI_API_KEY).toBe("sk-bad");
    expectCredentialPromptWasSecret(prompt);
    expect(log).toHaveBeenCalledWith(
      "  Type back to choose a different provider, or exit to quit.",
    );
    expectHelpBeforeSelectionReturn(log);
  });

  it("rechecks sandbox identity after recovery input before credential persistence (#9833)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-existing");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { helpers, prompt } = createRecoveryPrompt(["retry", "sk-replacement"]);

    await expect(
      helpers.promptValidationRecovery(
        "OpenAI",
        CREDENTIAL_RECOVERY,
        "OPENAI_API_KEY",
        null,
        () => {
          throw new Error("live sandbox identity changed before the selected route");
        },
      ),
    ).rejects.toThrow(/live sandbox identity changed before/u);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(process.env.OPENAI_API_KEY).toBe("sk-existing");
  });
});
