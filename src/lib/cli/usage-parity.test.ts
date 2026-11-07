// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";

import { help } from "../actions/root-help";
import { visibleCommands } from "./command-registry";
import {
  visibleEntries,
  nonHiddenDisplayEntries,
  parseUsageHints,
  missingUsageFlags,
  extraUsageFlags,
} from "./usage-parity-support";

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

// help() calls console.log once with the full output string
let capturedHelp = "";
const helpOutput = vi.spyOn(console, "log").mockImplementation((...args) => {
  capturedHelp = String(args[0]);
});
help();
const publicHelp = capturedHelp;
helpOutput.mockRestore();

const publicHelpEntries = visibleEntries().filter(({ commandId }) =>
  visibleCommands().some((command) => command.commandId === commandId),
);

const nonHiddenEntries = nonHiddenDisplayEntries();

describe("public display usage parity", () => {
  test("verifies non-hidden entries list is populated", () => {
    expect(nonHiddenEntries.length).toBeGreaterThan(0);
  });

  test.each(nonHiddenEntries)(
    "has matching visible command for $commandId with usage '$usage'",
    ({ commandId, usage }) => {
      const command = visibleCommands().find(
        (candidate) => candidate.commandId === commandId && candidate.usage === usage,
      );
      expect(command).toBeDefined();
    },
  );

  /** Fail loudly if hint parsing ever yields nothing instead of silently passing. */
  const usageHints = parseUsageHints();
  test("parses usage hints", () => {
    expect(usageHints.length).toBeGreaterThan(0);
  });

  test("does not strip plain letters from ANSI SGR regex", () => {
    // The ANSI SGR regex must only match escape sequences, not plain text.
    // A regex that incorrectly includes `[` in a character class would strip
    // the literal "m" from words like "nemoclaw".
    expect("nemoclaw".replace(ANSI_SGR, "")).toBe("nemoclaw");
    expect("nemoclaw setup".replace(ANSI_SGR, "")).toBe("nemoclaw setup");
    expect("\u001b[1mbold\u001b[0m".replace(ANSI_SGR, "")).toBe("bold");
  });

  /** Match a help row line by the exact usage string followed by a boundary. */
  function matchesHelpRow(trimmed: string, usage: string): boolean {
    // The usage string appears at the start of the trimmed help row, followed
    // by padding whitespace (or the end of the line). Anchoring with the
    // literal usage followed by whitespace prevents "nemoclaw setup" from
    // matching the "nemoclaw setup-spark" row.
    return new RegExp(`^${usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s`).test(trimmed);
  }

  test.each(publicHelpEntries)(
    "shows documented flags for $usage in public CLI help",
    ({ commandId, usage, flags }) => {
      const command = visibleCommands().find(
        (candidate) => candidate.commandId === commandId && candidate.usage === usage,
      );
      expect(usage).toBe(command?.usage);
      const helpLine = publicHelp
        .split("\n")
        .map((line) => line.replace(ANSI_SGR, "").trimStart())
        .find((trimmed) => matchesHelpRow(trimmed, usage));
      expect(helpLine).toBeDefined();
      expect(helpLine ?? "").toContain(flags ?? "");
    },
  );

  test("does not match 'setup' row as 'setup-spark' (regression test)", () => {
    // A row beginning with "setup" should not match "setup-spark" lookups.
    // This ensures the help-line lookup uses exact usage matching, not prefix
    // matching. The bug: .startsWith("nemoclaw setup") would incorrectly match
    // both "nemoclaw setup" and "nemoclaw setup-spark" lines.
    const setupEntry = publicHelpEntries.find((e) => e.usage === "nemoclaw setup");
    const setupSparkEntry = publicHelpEntries.find((e) => e.usage === "nemoclaw setup-spark");
    expect(setupEntry).toBeDefined();
    expect(setupSparkEntry).toBeDefined();

    const trimmedLines = publicHelp
      .split("\n")
      .map((line) => line.replace(ANSI_SGR, "").trimStart());

    // Looking for "nemoclaw setup" (boundary) must not match "nemoclaw setup-spark"
    const setupLines = trimmedLines.filter((trimmed) => matchesHelpRow(trimmed, "nemoclaw setup"));
    expect(setupLines.length).toBeGreaterThanOrEqual(1);
    expect(setupLines.some((line) => line.startsWith("nemoclaw setup-spark"))).toBe(false);

    // Looking for "nemoclaw setup-spark" still finds its own row
    const setupSparkLines = trimmedLines.filter((trimmed) =>
      matchesHelpRow(trimmed, "nemoclaw setup-spark"),
    );
    expect(setupSparkLines.length).toBeGreaterThanOrEqual(1);
  });

  test.each(visibleEntries())(
    "documents every usage flag of %s (%s)",
    ({ commandId, usage: _usage, flags, subcommand }) => {
      const missing = missingUsageFlags(commandId, flags, subcommand);
      expect(missing).toEqual([]);
      const extra = extraUsageFlags(commandId, flags, subcommand);
      expect(extra).toEqual([]);
    },
  );

  test.each(usageHints)(
    "documents every usage flag in hint for %s (%s)",
    ({ commandId, hint }) => {
      const missing = missingUsageFlags(commandId, hint);
      expect(missing).toEqual([]);
      const extra = extraUsageFlags(commandId, hint);
      expect(extra).toEqual([]);
    },
  );
});
