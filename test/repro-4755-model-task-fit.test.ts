// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for issue #4755:
 *   inference-options page lacks per-model task-fit guidance, so a reader
 *   trying to "pick the right model for my use case" has no basis for the
 *   decision (JTBD-4).
 *
 * Locks in a repo-grounded "Choosing a Model for Your Task" section that maps
 * a use case to a recommended option, a grounded rationale, and where to
 * configure it. Every row cites an existing page/section or NEMOCLAW_* knob,
 * so this test also guards against the cited links/knobs drifting away.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const PAGE_PATH = path.join(REPO_ROOT, "docs", "inference", "inference-options.mdx");
const page = fs.readFileSync(PAGE_PATH, "utf8");

describe("inference-options model task-fit guidance (#4755)", () => {
  it("adds the task-fit section before the Nemotron routing section", () => {
    const taskFit = page.indexOf("## Choosing a Model for Your Task");
    const nemotron = page.indexOf("## Choosing the Right Option for Nemotron");
    expect(taskFit).toBeGreaterThan(-1);
    expect(nemotron).toBeGreaterThan(-1);
    expect(taskFit).toBeLessThan(nemotron);
  });

  it("documents the task-fit table header", () => {
    expect(page).toContain("| Your task | Recommended option | Why | Where to configure |");
  });

  it.each([
    "Tool-heavy or agentic work",
    "Cost-sensitive or mixed workload",
    "Long-context prompts",
    "Multimodal (image input)",
    "Local, offline, or privacy-sensitive",
  ])("covers the %s use case", (useCase) => {
    expect(page).toContain(useCase);
  });

  it.each([
    "NEMOCLAW_CONTEXT_WINDOW",
    "NEMOCLAW_INFERENCE_INPUTS=text,image",
  ])("grounds configuration in %s", (knob) => {
    expect(page).toContain(knob);
  });

  it.each([
    "(tool-calling-reliability)",
    "(#model-router)",
    "(switch-inference-providers#tune-model-metadata)",
    "(use-local-inference)",
  ])("cites the %s link", (link) => {
    expect(page).toContain(link);
  });

  it("does not assert relative latency or price rankings", () => {
    const section = page.slice(
      page.indexOf("## Choosing a Model for Your Task"),
      page.indexOf("## Choosing the Right Option for Nemotron"),
    );
    expect(section).toMatch(/does not rank models on those axes/);
  });
});
