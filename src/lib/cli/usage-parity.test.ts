// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";

import { help } from "../actions/root-help";
import { visibleCommands } from "./command-registry";
import { visibleEntries, parseUsageHints, missingUsageFlags, extraUsageFlags } from "./usage-parity-support";

describe("public display usage parity", () => {
  /** Fail loudly if hint parsing ever yields nothing instead of silently passing. */
  const usageHints = parseUsageHints();
  test("parses usage hints", () => {
    expect(usageHints.length).toBeGreaterThan(0);
  });

  test("shows documented flags in public CLI help", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      help();
      const publicHelp = String(output.mock.calls[0]?.[0] ?? "");
      for (const { usage, flags } of visibleEntries()) {
        if (!visibleCommands().some((command) => command.usage === usage)) continue;
        expect(publicHelp, usage).toContain(usage);
        if (flags) expect(publicHelp, usage).toContain(flags);
      }
    } finally {
      output.mockRestore();
    }
  });

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
