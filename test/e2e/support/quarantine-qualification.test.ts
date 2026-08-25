// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listAgents, loadAgent } from "../../../src/lib/agent/defs.ts";
import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";

describe("all-agent quarantine qualification", () => {
  it.each(listAgents({}))(
    "maps default selectable manifest %s to its own required live lane (#10140)",
    (agentName) => {
      const qualification = loadAgent(agentName, {}).quarantineQualification;
      expect(qualification, agentName).not.toBeNull();
      expect(catalogueTarget(qualification!.liveE2eTarget)).toMatchObject({
        id: qualification!.liveE2eTarget,
        agentRuntime: agentName,
        testFile: "test/e2e/live/sandbox-quarantine.test.ts",
        prAdvisorSelectable: true,
        releaseRequired: true,
      });
    },
  );

  it("keeps the quarantine core manifest-driven without agent-name branches (#10140)", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/lib/actions/sandbox/quarantine/index.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/agent(?:Name)?\s*[!=]==?\s*["']/u);
  });
});
