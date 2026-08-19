// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as credentials from "../credentials/store";
import { validateNvidiaApiKeyValue } from "../validation";
import {
  BACK_TO_SELECTION,
  replaceNamedCredential,
  returningToProviderSelection,
  shouldReturnToProviderSelection,
} from "./credential-navigation";
import { createValidationRecoveryPromptHelpers } from "./validation-recovery-prompt";

describe("credential prompt navigation helpers", () => {
  it("treats both the shared back sentinel and credential back intents as provider-selection navigation", () => {
    const exitOnboard = vi.fn(() => {
      throw new Error("unexpected exit");
    }) as unknown as () => never;

    expect(shouldReturnToProviderSelection(BACK_TO_SELECTION, exitOnboard)).toBe(true);
    expect(shouldReturnToProviderSelection({ kind: "back" }, exitOnboard)).toBe(true);
    expect(
      shouldReturnToProviderSelection({ kind: "credential", value: "back" }, exitOnboard),
    ).toBe(false);
    expect(exitOnboard).not.toHaveBeenCalled();
  });

  it("exits for credential exit intents instead of treating them as back navigation", () => {
    const exitError = new Error("exit");
    const exitOnboard = vi.fn(() => {
      throw exitError;
    }) as unknown as () => never;

    expect(() => shouldReturnToProviderSelection({ kind: "exit" }, exitOnboard)).toThrow(exitError);
    expect(exitOnboard).toHaveBeenCalledTimes(1);
  });

  it("prints the provider-selection message whenever a value returns to provider selection", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const exitOnboard = vi.fn(() => {
        throw new Error("unexpected exit");
      }) as unknown as () => never;

      expect(returningToProviderSelection({ kind: "back" }, exitOnboard)).toBe(true);
      expect(returningToProviderSelection({ kind: "help" }, exitOnboard)).toBe(false);
    } finally {
      console.log = originalLog;
    }

    expect(logs).toEqual(["  Returning to provider selection.", ""]);
  });

  it("keeps the prompt and accepts an empty optional credential (#7424)", async () => {
    const prompt = vi
      .spyOn(credentials, "readCredentialPrompt")
      .mockResolvedValue({ kind: "credential", value: "" });
    try {
      await expect(
        replaceNamedCredential({
          envName: "NEMOCLAW_TEST_OPTIONAL_CREDENTIAL",
          label: "API key (press Enter for no authentication)",
          allowEmpty: true,
          exitOnboardFromPrompt: () => process.exit(1),
        }),
      ).resolves.toBe("");
      expect(prompt).toHaveBeenCalledWith(
        "  API key (press Enter for no authentication): ",
        expect.any(Function),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("returns to provider selection instead of staging back as the re-entered API key (#3697)", async () => {
    const answers = ["retry", "", "back"];
    const exitOnboardFromPrompt = vi.fn(() => {
      throw new Error("unexpected exit");
    }) as unknown as () => never;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { promptValidationRecovery } = createValidationRecoveryPromptHelpers({
      isNonInteractive: () => false,
      prompt: async () => answers.shift() ?? "",
      validateNvidiaApiKeyValue: (key, credentialEnv) =>
        validateNvidiaApiKeyValue(key, credentialEnv ?? undefined),
      getTransportRecoveryMessage: () => "",
      exitOnboardFromPrompt,
    });
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        promptValidationRecovery(
          "OpenAI",
          { kind: "credential", retry: "credential" },
          "OPENAI_API_KEY",
        ),
      ).resolves.toBe("selection");
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(answers).toEqual([]);
      expect(exitOnboardFromPrompt).not.toHaveBeenCalled();
      // The escape route is the contract here, so a bare required-field notice is not enough:
      // the re-prompt has to name both ways out of the loop, in either order.
      const [[requiredMessage]] = consoleError.mock.calls;
      expect(requiredMessage).toContain("is required.");
      expect(requiredMessage).toContain("back");
      expect(requiredMessage).toContain("exit");
    } finally {
      delete process.env.OPENAI_API_KEY;
      vi.restoreAllMocks();
    }
  });
});
