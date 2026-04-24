// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("config set CLI dispatch", () => {
  it("awaits configSet from the command dispatcher", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "nemoclaw.ts"), "utf-8");
    expect(src).toContain("await sandboxConfig.configSet(cmd, setOpts);");
  });
});
