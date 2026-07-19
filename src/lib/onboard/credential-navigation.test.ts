// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as credentials from "../credentials/store";

import {
  BACK_TO_SELECTION,
  getNavigationChoice,
  replaceNamedCredential,
  returningToProviderSelection,
  shouldReturnToProviderSelection,
} from "./credential-navigation";

let navigationKeyBeforeTest: string | undefined;

beforeEach(() => {
  navigationKeyBeforeTest = process.env.NEMOCLAW_TEST_NAVIGATION_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (navigationKeyBeforeTest === undefined) {
    delete process.env.NEMOCLAW_TEST_NAVIGATION_KEY;
  } else {
    process.env.NEMOCLAW_TEST_NAVIGATION_KEY = navigationKeyBeforeTest;
  }
});

describe("credential prompt navigation helpers (#6005)", () => {
  it("accepts the short b token as back so the advertised key works", () => {
    expect(getNavigationChoice("b")).toBe("back");
    expect(getNavigationChoice(" B ")).toBe("back");
    expect(getNavigationChoice("back")).toBe("back");
    expect(getNavigationChoice("exit")).toBe("exit");
    expect(getNavigationChoice("nvapi-xxxx")).toBeNull();
  });

  it("routes a trimmed short b token through the real secret prompt without staging it", async () => {
    vi.spyOn(credentials, "prompt").mockResolvedValue(" B ");
    const saveCredential = vi.spyOn(credentials, "saveCredential");
    const exitOnboard = vi.fn(() => {
      throw new Error("unexpected exit");
    }) as unknown as () => never;

    const result = await replaceNamedCredential({
      envName: "NEMOCLAW_TEST_NAVIGATION_KEY",
      label: "Test credential",
      exitOnboardFromPrompt: exitOnboard,
    });

    expect(result).toBe(BACK_TO_SELECTION);
    expect(saveCredential).not.toHaveBeenCalled();
    expect(process.env.NEMOCLAW_TEST_NAVIGATION_KEY).toBe(navigationKeyBeforeTest);
  });

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
});
