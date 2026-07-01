// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const auditDocPath = path.join(repoRoot, "docs", "inference", "model-capability-audit.mdx");
const navPath = path.join(repoRoot, "docs", "index.yml");

const resultStates = [
  "pass",
  "pass-with-affordance",
  "degraded",
  "blocked",
  "unsupported",
  "not-yet-run",
] as const;

const evidenceFields = [
  "Model ID",
  "Provider path",
  "Agent surface",
  "NemoClaw commit SHA",
  "Runtime versions",
  "Endpoint/API path selected",
  "Workflow used",
  "State",
  "Evidence",
  "Observed tool-call count",
  "Final-response behavior",
  "Multi-turn behavior",
  "Latency and timeout notes",
  "Required affordance",
  "Follow-up",
] as const;

describe("model capability audit doc (#3123)", () => {
  it("keeps the maintained audit states and evidence schema", () => {
    const markdown = fs.readFileSync(auditDocPath, "utf8");

    for (const state of resultStates) {
      expect(markdown).toContain(`\`${state}\``);
    }
    for (const field of evidenceFields) {
      expect(markdown).toContain(field);
    }

    expect(markdown).toContain(
      "Agent surface | Provider class | Model or route | API path | State | Evidence",
    );
  });

  it("links the audit page from both guide variants", () => {
    const nav = fs.readFileSync(navPath, "utf8");

    expect(nav).toContain(
      "_build/agent-variants/inference/model-capability-audit.openclaw.generated.mdx",
    );
    expect(nav).toContain(
      "_build/agent-variants/inference/model-capability-audit.hermes.generated.mdx",
    );
  });

  it("keeps next-step links for related inference docs", () => {
    const markdown = fs.readFileSync(auditDocPath, "utf8");

    expect(markdown).toContain("## Next Steps");
    expect(markdown).toContain("[Inference Options](inference-options)");
    expect(markdown).toContain("[Tool-Calling Reliability](tool-calling-reliability)");
    expect(markdown).toContain("[Architecture](../reference/architecture)");
  });
});
