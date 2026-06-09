// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  promptOrDefault,
  selectFromNumberedMenuOrExit,
} from "../../../dist/lib/onboard/prompt-helpers";

function makeDeps(promptReply: string) {
  return {
    isNonInteractive: () => false,
    note: vi.fn(),
    prompt: vi.fn().mockResolvedValue(promptReply),
  };
}

describe("promptOrDefault interactive default fallback (#4387)", () => {
  it("returns defaultValue when the user just presses Enter (empty reply)", async () => {
    const deps = makeDeps("");
    expect(await promptOrDefault(deps, "  Choose [6]: ", null, "6")).toBe("6");
  });

  it("treats a whitespace-only reply as the default", async () => {
    const deps = makeDeps("   ");
    expect(await promptOrDefault(deps, "  Choose [6]: ", null, "6")).toBe("6");
  });

  it("returns the user's reply verbatim when non-empty", async () => {
    const deps = makeDeps("3");
    expect(await promptOrDefault(deps, "  Choose [6]: ", null, "6")).toBe("3");
  });
});

describe("selectFromNumberedMenuOrExit (#4514)", () => {
  const options = [
    { key: "build", label: "NVIDIA Endpoints" },
    { key: "openai", label: "OpenAI" },
    { key: "custom", label: "Other OpenAI-compatible endpoint" },
  ];

  it("returns the default option on bare Enter", () => {
    expect(selectFromNumberedMenuOrExit("", 1, options)).toBe(options[0]);
  });

  it("returns the chosen option for a valid number", () => {
    expect(selectFromNumberedMenuOrExit("2", 1, options)).toBe(options[1]);
  });

  it("falls back to the default for an out-of-range number", () => {
    expect(selectFromNumberedMenuOrExit("99", 1, options)).toBe(options[0]);
  });

  it.each([
    "exit",
    "EXIT",
    "quit",
    "Quit",
    "  exit  ",
  ])("cancels onboarding when the reply is %j", (reply) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => selectFromNumberedMenuOrExit(reply, 1, options)).toThrow("process.exit(1)");
      expect(logSpy).toHaveBeenCalledWith("  Exiting onboarding.");
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("does not treat non-navigation words as exit", () => {
    expect(selectFromNumberedMenuOrExit("3", 1, options)).toBe(options[2]);
  });

  it("returns a valid falsy option instead of silently swapping to the default", () => {
    const numericOptions = [0, 1, 2];
    expect(selectFromNumberedMenuOrExit("1", 2, numericOptions)).toBe(0);
  });

  it("falls back to the default when the chosen index points to an undefined slot", () => {
    const sparse: Array<string | undefined> = ["a", undefined, "c"];
    expect(selectFromNumberedMenuOrExit("2", 1, sparse)).toBe(undefined);
    expect(selectFromNumberedMenuOrExit("4", 1, sparse)).toBe("a");
  });

  it("treats `back` as non-navigation and falls back to the bracketed default", () => {
    expect(selectFromNumberedMenuOrExit("back", 1, options)).toBe(options[0]);
  });
});
