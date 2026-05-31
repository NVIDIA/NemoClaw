// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  promptOrDefault,
  selectFromNumberedMenu,
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

describe("selectFromNumberedMenu (#4514)", () => {
  const options = [
    { key: "build", label: "NVIDIA Endpoints" },
    { key: "openai", label: "OpenAI" },
    { key: "custom", label: "Other OpenAI-compatible endpoint" },
  ];

  it("returns the default option on bare Enter", () => {
    expect(selectFromNumberedMenu("", 1, options)).toBe(options[0]);
  });

  it("returns the chosen option for a valid number", () => {
    expect(selectFromNumberedMenu("2", 1, options)).toBe(options[1]);
  });

  it("falls back to the default for an out-of-range number", () => {
    expect(selectFromNumberedMenu("99", 1, options)).toBe(options[0]);
  });

  it.each(["exit", "EXIT", "quit", "Quit", "  exit  "])(
    "cancels onboarding when the reply is %j",
    (reply) => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() => selectFromNumberedMenu(reply, 1, options)).toThrow("process.exit(1)");
        expect(logSpy).toHaveBeenCalledWith("  Exiting onboarding.");
      } finally {
        exitSpy.mockRestore();
        logSpy.mockRestore();
      }
    },
  );

  it("does not treat non-navigation words as exit", () => {
    expect(selectFromNumberedMenu("3", 1, options)).toBe(options[2]);
  });
});
