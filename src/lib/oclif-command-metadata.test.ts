// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import commands from "../../dist/lib/commands/index.js";

const publicCommandEntries = Object.entries(commands).filter(([, commandClass]) => {
  const cls = commandClass as { hidden?: boolean };
  return cls.hidden !== true;
});

describe("oclif command metadata", () => {
  it("keeps public registered commands documented in oclif statics", () => {
    const missing: string[] = [];
    for (const [id, commandClass] of publicCommandEntries) {
      const cls = commandClass as {
        description?: string;
        examples?: string[];
        summary?: string;
        usage?: string[];
      };
      if (!cls.summary) missing.push(`${id}: summary`);
      if (!cls.description) missing.push(`${id}: description`);
      if (!Array.isArray(cls.usage) || cls.usage.length === 0) missing.push(`${id}: usage`);
      if (!Array.isArray(cls.examples) || cls.examples.length === 0) missing.push(`${id}: examples`);
    }

    expect(missing).toEqual([]);
  });
});
