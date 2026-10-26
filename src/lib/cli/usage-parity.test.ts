// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";

import { help } from "../actions/root-help";
import { visibleCommands } from "./command-registry";
import { visibleEntries, parseUsageHints, missingUsageFlags, extraUsageFlags } from "./usage-parity-support";

const helpOutput = vi.spyOn(console, "log").mockImplementation(() => {});
help();
const publicHelp = String(helpOutput.mock.calls[0]?.[0] ?? "");
helpOutput.mockRestore();

const publicHelpEntries = visibleEntries()
  .filter(({ usage }) => visibleCommands().some((command) => command.usage === usage))
  .map(({ usage, flags }) => ({ usage, flags }));

describe("public display usage parity", () => {
  /** Fail loudly if hint parsing ever yields nothing instead of silently passing. */
  const usageHints = parseUsageHints();
  test("parses usage hints", () => {
    expect(usageHints.length).toBeGreaterThan(0);
  });

  test.each(publicHelpEntries)(
    "shows documented flags for $usage in public CLI help",
    ({ usage, flags }) => {
      expect(publicHelp, usage).toContain(usage);
      expect(publicHelp, usage).toContain(flags ?? "");
    },
  );

  test.each(visibleEntries())(
    "documents every usage flag of %s (%s)",
    ({ commandId, usage: _usage, flags }) => {
      const missing = missingUsageFlags(commandId, flags);
      expect(missing).toEqual([]);
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
