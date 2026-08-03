// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as credentials from "../credentials/store";
import {
  BACK_TO_SELECTION,
  createCredentialPromptHelpers,
  replaceNamedCredential,
  returningToProviderSelection,
  shouldReturnToProviderSelection,
} from "./credential-navigation";

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

  it("does not advertise or accept Back after the Apply boundary (#6005)", async () => {
    const logs: string[] = [];
    const prompt = vi
      .spyOn(credentials, "readCredentialPrompt")
      .mockResolvedValueOnce({ kind: "help" })
      .mockResolvedValueOnce({ kind: "back" });
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const unavailable = new Error("Back unavailable; rerun onboard --fresh");
    const helpers = createCredentialPromptHelpers(
      () => {
        throw new Error("unexpected exit");
      },
      {
        canReturnToProviderSelection: () => false,
        onBackUnavailable: () => {
          throw unavailable;
        },
      },
    );
    try {
      await expect(helpers.readValue("secret: ")).rejects.toThrow(unavailable);
    } finally {
      prompt.mockRestore();
      log.mockRestore();
    }

    expect(logs).toContain("  Back is unavailable after Apply configuration; use exit to quit.");
    expect(logs.join("\n")).not.toContain("choose a different provider");
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
});
