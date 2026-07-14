// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createPolicySelectionPromptHelpers,
  type PolicySelectionPromptDeps,
} from "../src/lib/onboard/policy-selection-prompts";

type Preset = {
  name: string;
  description: string;
};

type SelectorOptions = {
  presets?: Preset[];
  initialSelected?: string[];
};

const SAMPLE_PRESETS: Preset[] = [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
  { name: "slack", description: "Slack API access" },
];

/**
 * Run presetsCheckboxSelector with neither stdin nor stdout marked as a TTY,
 * forcing the non-TTY fallback path.
 *
 * `promptResponse` is what the stubbed prompt() returns — i.e., whatever the
 * user would have typed at the "Select presets" prompt.
 */
async function runCheckboxSelector(
  promptResponse: string,
  { presets = SAMPLE_PRESETS, initialSelected = [] }: SelectorOptions = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    stdout.push(args.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map(String).join(" "));
  });
  const prompt = vi.fn(async () => promptResponse);

  const deps: PolicySelectionPromptDeps = {
    tiers: {
      listTiers: () => [],
      getTier: () => null,
    },
    policyTierEnv: {
      resolvePolicyTierFromEnv: () => "balanced",
    },
    isNonInteractive: () => false,
    note: () => undefined,
    prompt,
    selectFromNumberedMenuOrExit: () => {
      throw new Error("unexpected numbered-menu selection");
    },
    makeOnboardCancelExit: (_rollback, cleanup) => () => cleanup(),
    sandboxCancelRollback: { markCancelled: () => undefined },
    useColor: false,
    stdin: {
      isTTY: false,
      on: () => undefined,
      pause: () => undefined,
      removeListener: () => undefined,
      resume: () => undefined,
      setEncoding: () => undefined,
      setRawMode: () => undefined,
    },
    stdout: {
      isTTY: false,
      write: () => true,
    },
    processEvents: {
      once: () => undefined,
      removeListener: () => undefined,
    },
  };

  try {
    const selection = await createPolicySelectionPromptHelpers(deps).presetsCheckboxSelector(
      presets,
      initialSelected,
    );
    return {
      status: 0,
      selection,
      stdout: `${stdout.join("\n")}\n`,
      stderr: stderr.length > 0 ? `${stderr.join("\n")}\n` : "",
      prompt,
    };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("presetsCheckboxSelector (non-TTY path)", () => {
  describe("zero presets", () => {
    it("returns [] immediately without calling prompt", async () => {
      const result = await runCheckboxSelector("should-not-matter", { presets: [] });
      expect(result.status).toBe(0);
      expect(result.selection).toEqual([]);
      expect(result.prompt).not.toHaveBeenCalled();
    });

    it("prints a friendly message when no presets exist", async () => {
      const result = await runCheckboxSelector("", { presets: [] });
      expect(result.stdout).toContain("No policy presets are available.");
    });
  });

  describe("empty input", () => {
    it("returns [] when the user presses Enter without typing", async () => {
      const result = await runCheckboxSelector("");
      expect(result.status).toBe(0);
      expect(result.selection).toEqual([]);
    });

    it("prints 'Skipping policy presets.' on empty input", async () => {
      const result = await runCheckboxSelector("  ");
      expect(result.stdout).toContain("Skipping policy presets.");
    });
  });

  describe("valid input", () => {
    it("returns a single named preset", async () => {
      const result = await runCheckboxSelector("npm");
      expect(result.status).toBe(0);
      expect(result.selection).toEqual(["npm"]);
    });

    it("returns multiple comma-separated presets in order", async () => {
      const result = await runCheckboxSelector("npm, pypi");
      expect(result.status).toBe(0);
      expect(result.selection).toEqual(["npm", "pypi"]);
    });

    it("trims whitespace around each name", async () => {
      const result = await runCheckboxSelector("  npm  ,  slack  ");
      expect(result.status).toBe(0);
      expect(result.selection).toEqual(["npm", "slack"]);
    });
  });

  describe("unknown preset names", () => {
    it("drops unknown names and returns only valid ones", async () => {
      const result = await runCheckboxSelector("npm, typo");
      expect(result.status).toBe(0);
      expect(result.selection).toEqual(["npm"]);
    });

    it("warns about each unknown name on stderr", async () => {
      // console.error() → stderr; console.log() → stdout
      const result = await runCheckboxSelector("npm, typo, alsowrong");
      expect(result.stderr).toContain("Unknown preset name ignored: typo");
      expect(result.stderr).toContain("Unknown preset name ignored: alsowrong");
    });

    it("returns [] when all names are unknown", async () => {
      const result = await runCheckboxSelector("bad1, bad2");
      expect(result.status).toBe(0);
      expect(result.selection).toEqual([]);
    });
  });

  describe("preset listing output", () => {
    it("prints all preset names in the listing", async () => {
      const result = await runCheckboxSelector("");
      expect(result.stdout).toContain("npm");
      expect(result.stdout).toContain("pypi");
      expect(result.stdout).toContain("slack");
    });

    it("marks initialSelected presets as checked ([✓]) and others as unchecked ([ ])", async () => {
      const result = await runCheckboxSelector("", { initialSelected: ["npm"] });
      expect(result.stdout).toContain("[✓]");
      expect(result.stdout).toContain("[ ]");
      // npm line should have the check, pypi should not
      const lines = result.stdout.split("\n");
      const npmLine = lines.find((l) => l.includes("npm"));
      const pypiLine = lines.find((l) => l.includes("pypi"));
      expect(npmLine).toContain("[✓]");
      expect(pypiLine).toContain("[ ]");
    });

    it("shows descriptions alongside names", async () => {
      const result = await runCheckboxSelector("");
      expect(result.stdout).toContain("npm and Yarn registry access");
      expect(result.stdout).toContain("Python Package Index (PyPI) access");
    });
  });

  describe("NO_COLOR respected", () => {
    it("uses plain [✓] marker when NO_COLOR is set", async () => {
      const result = await runCheckboxSelector("", { initialSelected: ["npm"] });
      // Color output is disabled through the injected dependency.
      expect(result.stdout).not.toContain("\x1b[");
    });
  });
});
