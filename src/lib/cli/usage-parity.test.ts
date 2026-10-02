// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { visibleEntries, parseUsageHints, missingUsageFlags } from "./usage-parity-support";

describe("public display usage parity", () => {
  /** Fail loudly if hint parsing ever yields nothing instead of silently passing. */
  const usageHints = parseUsageHints();
  test("parses usage hints", () => {
    expect(usageHints.length).toBeGreaterThan(0);
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
    },
  );
});
