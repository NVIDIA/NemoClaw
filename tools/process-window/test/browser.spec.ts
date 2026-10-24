// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { configSchema, type Mapping } from "../src/model.js";
import { render } from "../src/build.js";

test("browser selects branches, lists every counted input, and links to pinned sources", async () => {
  const config = configSchema.parse({
    repository: { path: ".", url: "https://github.com/example/sample", forge: "github" },
    origins: [
      { id: "broad", name: "Repository guides", paths: ["guides/"] },
      { id: "specific", name: "Specific prompt", paths: ["guides/input 1.ts"] },
    ],
    mapping: "sample.yaml",
    output: ".local/browser-test",
    stages: [
      { id: "plan", name: "Plan" },
      { id: "write", name: "Write" },
      { id: "review", name: "Review" },
    ],
    categories: [
      { id: "docs", name: "Reference documents" },
      { id: "prompts", name: "Agent prompts" },
    ],
    branches: [
      {
        id: "main",
        name: "Sample main",
        ref: "main",
        color: "#3475ad",
        refresh: { mode: "manual" },
      },
      {
        id: "next",
        name: "Sample next",
        ref: "next",
        color: "#669c20",
        refresh: { mode: "branch" },
      },
    ],
    inference: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
      model: "unused",
    },
  });
  const mapping: Mapping = {
    version: 1,
    repository: config.repository.url,
    branches: config.branches.map((b, n) => ({
      id: b.id,
      revision: String(n + 1).repeat(40),
      inputs: Array.from({ length: n + 2 }, (_, i) => ({
        id: `guide-${i}`,
        name: `${b.name} input ${i + 1}`,
        category: i % 2 ? "prompts" : "docs",
        stages: i % 2 ? ["write", "review"] : ["plan", "write"],
        source: { path: `guides/input ${i}.ts`, start: 1 },
        displayName: `Read ${b.id} guidance ${i + 1}`,
        evidence: "This synthetic browser fixture tests navigation and count consistency.",
        note: i ? undefined : "Unresolved: check this classification against current evidence.",
      })),
    })),
  };
  for (const branch of mapping.branches)
    branch.mechanisms = [
      {
        id: "reviewer",
        name: "Example reviewer",
        usages: [
          {
            stage: "write",
            trigger: "Contributor requests review",
            summary: "Before submission, the reviewer checks the proposed change.",
            inputIds: ["guide-0", "guide-1"],
            basis: "verified",
            agentUse: "The reviewer agent receives these inputs in its prompt.",
            source: { path: "review.ts", start: 12 },
            evidence: "The fixture reviewer supplies both inputs to its review prompt.",
            outcome: "Review findings",
          },
        ],
      },
      {
        id: "uncertain-reviewer",
        name: "Uncertain reviewer",
        usages: [
          {
            stage: "review",
            trigger: "Not established",
            inputIds: ["guide-0"],
            basis: "unresolved",
            evidence: "Possible review use conflicts with retained planning placement.",
            outcome: "Possible findings",
            note: "Review the cross-phase relationship.",
          },
        ],
      },
    ];
  for (const branch of mapping.branches)
    branch.mechanisms![0]!.usages[0]!.requirements = [
      {
        inputIds: ["guide-0"],
        level: "conditional",
        condition: "The change touches security-sensitive behavior.",
        evidence: "The workflow requires this reference for security changes.",
        source: { path: "review.ts", start: 12 },
      },
      {
        inputIds: ["guide-1"],
        level: "available",
        evidence: "The workflow offers this optional reference.",
        source: { path: "review.ts", start: 15 },
      },
    ];
  for (const branch of mapping.branches)
    branch.inputs.push({
      id: "unplaced",
      name: "Unplaced candidate",
      category: "docs",
      stages: [],
      source: { path: "guides/unplaced.md", start: 1 },
      evidence: "No agent consumer established.",
    });
  const output = resolve(".local/browser-test");
  await render(config, mapping, output);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(pathToFileURL(`${output}/index.html`).href);
    for (const branch of mapping.branches) {
      await page.selectOption("#branch", branch.id);
      assert.ok((await page.locator("#revision").innerText()).includes(branch.revision));
      assert.equal(await page.locator("details[open]").count(), 0);
      assert.equal(await page.locator("#focus-panel").isVisible(), false);
      const writing = page.locator(".phase").nth(1);
      assert.deepEqual(
        await writing
          .locator(".origin-tile")
          .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.origin)),
        ["broad", "specific"],
      );
      const broad = writing.locator('[data-origin="broad"]');
      await broad.click();
      assert.equal(await broad.getAttribute("aria-expanded"), "true");
      const panel = page.locator("#focus-panel");
      assert.match(await panel.locator("h2").innerText(), /Write.*Repository guides/);
      assert.equal(await panel.locator(".origin-group:visible").count(), 1);
      const input = panel.locator('[data-input="guide-0"]');
      assert.equal(
        await input.locator(".usage-trigger").innerText(),
        "Before submission, the reviewer checks the proposed change.",
      );
      assert.equal(await input.locator("a").count(), 1);
      assert.equal(await input.locator("details").count(), 0);
      assert.equal(await input.locator("a").innerText(), `Read ${branch.id} guidance 1`);
      assert.equal(
        await input.locator("a").getAttribute("href"),
        `https://github.com/example/sample/blob/${branch.revision}/guides/input%200.ts#L1`,
      );
      assert.equal(
        await panel.locator(".usage-evidence,.guidance-detail,.evidence-entry").count(),
        0,
      );
      await writing.locator('[data-origin="specific"]').click();
      assert.equal(await panel.locator(".origin-group:visible").count(), 1);
      assert.equal(await input.isVisible(), false);
      assert.equal(await panel.locator('[data-input="guide-1"]').isVisible(), true);
      await page.getByRole("button", { name: "Close details" }).click();
      assert.equal(await panel.isVisible(), false);
      assert.equal(await writing.locator("[aria-expanded=true]").count(), 0);
      await broad.click();
      await page.keyboard.press("Escape");
      assert.equal(await panel.isVisible(), false);
      assert.equal(await broad.evaluate((e) => e === document.activeElement), true);
      const stages = await page.locator(".stage").all();
      const boxes = await Promise.all(stages.map((s) => s.boundingBox()));
      assert.ok(
        boxes.every((b) => Math.abs(b!.y - boxes[0]!.y) < 2),
        "All phases share a horizontal row",
      );
      assert.ok(boxes.at(-1)!.x > boxes[0]!.x);
      await page.locator("#unmapped > summary").click();
      const unplaced = page.locator('#unmapped [data-pending-input="unplaced"]');
      await unplaced.locator("summary").click();
      assert.match(await unplaced.innerText(), /No lifecycle placement established/);
      assert.equal(await page.locator('#focus-panel [data-input="unplaced"]').count(), 0);
      const pending = page.locator('#unmapped [data-pending-input="guide-0"]');
      await pending.locator("summary").click();
      assert.match(await pending.innerText(), /Uncertain reviewer/);
      await page.locator('#source-filter [data-origin="specific"]').click();
      assert.equal(await page.locator("#focus-panel").isVisible(), false);
      assert.equal(await writing.locator('[data-origin="broad"]').count(), 0);
      assert.equal(await page.locator('#unmapped [data-pending-input="guide-0"]').count(), 0);
      await page.locator('#source-filter [data-origin="broad"]').click();
      assert.equal(await writing.locator(".origin-tile").count(), 2);
      await page.getByRole("button", { name: "All sources", exact: true }).click();
    }
    await page
      .locator("details")
      .evaluateAll((elements) => elements.forEach((e) => e.removeAttribute("open")));
    await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
    await page.locator(".origin-tile").first().click();
    await page.screenshot({ path: `${output}/expanded.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
    await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
