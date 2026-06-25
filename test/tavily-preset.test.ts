// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import * as policies from "../dist/lib/policy";

describe("tavily opt-in preset", () => {
  it("declares api.tavily.com egress and the interpreter binaries it allows", () => {
    const tavily = policies.loadPreset("tavily");
    expect(tavily).not.toBeNull();
    const content = String(tavily);
    expect(content).toContain("api.tavily.com");
    expect(content).toContain("/usr/bin/python3*");
    expect(content).toContain("/usr/bin/node");
    expect(content).toContain("/usr/bin/curl");
  });
});
