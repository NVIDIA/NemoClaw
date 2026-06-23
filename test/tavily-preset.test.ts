// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as policies from "../dist/lib/policy";

const REPO_ROOT = path.join(import.meta.dirname, "..");

describe("tavily opt-in preset", () => {
  it("declares api.tavily.com and stays out of the Deep Agents Code default policy", () => {
    const tavily = policies.loadPreset("tavily");
    expect(tavily).not.toBeNull();
    const content = String(tavily);
    expect(content).toContain("api.tavily.com");
    expect(content).toContain("/usr/bin/python3*");
    expect(content).toContain("/usr/bin/node");
    expect(content).toContain("/usr/bin/curl");
    const deepagentsPolicy = fs.readFileSync(
      path.join(REPO_ROOT, "agents/langchain-deepagents-code/policy-additions.yaml"),
      "utf8",
    );
    expect(deepagentsPolicy).not.toContain("api.tavily.com");
    expect(deepagentsPolicy).not.toContain("api.smith.langchain.com");
  });
});
