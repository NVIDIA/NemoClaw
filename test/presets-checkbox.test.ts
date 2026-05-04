// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execTimeout } from "./helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const ONBOARD_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "onboard.js"));
const CREDENTIALS_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "credentials.js"));

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
 * Parse the JSON result from the last non-empty line of stdout.
 * The subprocess writes console.log output (preset listing, messages) to
 * stdout before the final JSON line, so we must look at only the last line.
 */
function parseResult(stdout: string): string[] {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const parsed: Array<string | null> = JSON.parse(lines[lines.length - 1]);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Run presetsCheckboxSelector in a subprocess where neither stdin nor stdout
 * is a TTY (spawnSync uses pipes), forcing the non-TTY fallback path.
 *
 * `promptResponse` is what the stubbed prompt() returns — i.e., whatever the
 * user would have typed at the "Select presets" prompt.
 */
function runCheckboxSelector(
  promptResponse: string,
  { presets = SAMPLE_PRESETS, initialSelected = [] }: SelectorOptions = {},
) {
  // Stub credentials.prompt BEFORE requiring onboard so the destructured
  // binding inside onboard.js picks up the stub at load time.
  const script = String.raw`
const credentials = require(${CREDENTIALS_PATH});
credentials.prompt = () => Promise.resolve(${JSON.stringify(promptResponse)});
const { presetsCheckboxSelector } = require(${ONBOARD_PATH});

const presets = JSON.parse(process.env.NEMOCLAW_TEST_PRESETS);
const initialSelected = JSON.parse(process.env.NEMOCLAW_TEST_INITIAL || "[]");

presetsCheckboxSelector(presets, initialSelected)
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
  })
  .catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
`;

  return spawnSync(process.execPath, ["-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: execTimeout(5_000),
    env: {
      ...process.env,
      NEMOCLAW_TEST_PRESETS: JSON.stringify(presets),
      NEMOCLAW_TEST_INITIAL: JSON.stringify(initialSelected),
      NO_COLOR: "1",
    },
  });
}

describe("presetsCheckboxSelector (non-TTY path)", () => {
  describe("zero presets", () => {
    it("returns [] immediately without calling prompt", () => {
      const result = runCheckboxSelector("should-not-matter", { presets: [] });
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toEqual([]);
    });

    it("prints a friendly message when no presets exist", () => {
      const result = runCheckboxSelector("", { presets: [] });
      expect(result.stdout).toContain("No policy presets are available.");
    });
  });

  describe("empty input", () => {
    it("returns [] when the user presses Enter without typing", () => {
      const result = runCheckboxSelector("");
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toEqual([]);
    });

    it("prints 'Skipping policy presets.' on empty input", () => {
      const result = runCheckboxSelector("  ");
      expect(result.stdout).toContain("Skipping policy presets.");
    });
  });

  describe("valid input", () => {
    it("returns a single named preset", () => {
      const result = runCheckboxSelector("npm");
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toEqual(["npm"]);
    });

    it("returns multiple comma-separated presets in order", () => {
      const result = runCheckboxSelector("npm, pypi");
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toEqual(["npm", "pypi"]);
    });

    it("trims whitespace around each name", () => {
      const result = runCheckboxSelector("  npm  ,  slack  ");
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toEqual(["npm", "slack"]);
    });
  });

  describe("unknown preset names", () => {
    it("drops unknown names and returns only valid ones", () => {
      const result = runCheckboxSelector("npm, typo");
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toEqual(["npm"]);
    });

    it("warns about each unknown name on stderr", () => {
      // console.error() → stderr; console.log() → stdout
      const result = runCheckboxSelector("npm, typo, alsowrong");
      expect(result.stderr).toContain("Unknown preset name ignored: typo");
      expect(result.stderr).toContain("Unknown preset name ignored: alsowrong");
    });

    it("returns [] when all names are unknown", () => {
      const result = runCheckboxSelector("bad1, bad2");
      expect(result.status).toBe(0);
      expect(parseResult(result.stdout)).toEqual([]);
    });
  });

  describe("preset listing output", () => {
    it("prints all preset names in the listing", () => {
      const result = runCheckboxSelector("");
      expect(result.stdout).toContain("npm");
      expect(result.stdout).toContain("pypi");
      expect(result.stdout).toContain("slack");
    });

    it("marks initialSelected presets as checked ([✓]) and others as unchecked ([ ])", () => {
      const result = runCheckboxSelector("", { initialSelected: ["npm"] });
      expect(result.stdout).toContain("[✓]");
      expect(result.stdout).toContain("[ ]");
      // npm line should have the check, pypi should not
      const lines = result.stdout.split("\n");
      const npmLine = lines.find((l) => l.includes("npm"));
      const pypiLine = lines.find((l) => l.includes("pypi"));
      expect(npmLine).toContain("[✓]");
      expect(pypiLine).toContain("[ ]");
    });

    it("shows descriptions alongside names", () => {
      const result = runCheckboxSelector("");
      expect(result.stdout).toContain("npm and Yarn registry access");
      expect(result.stdout).toContain("Python Package Index (PyPI) access");
    });
  });

  describe("NO_COLOR respected", () => {
    it("uses plain [✓] marker when NO_COLOR is set", () => {
      const result = runCheckboxSelector("", { initialSelected: ["npm"] });
      // NO_COLOR is set in the test env; no ANSI escape codes expected
      expect(result.stdout).not.toContain("\x1b[");
    });
  });
});
