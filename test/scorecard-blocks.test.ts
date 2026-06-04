// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ScorecardData } from "../scripts/scorecard/build-slack-blocks.ts";

type TestBlockElement = {
  text?: string | { text: string };
  style?: string;
  url?: string;
};

type TestSlackBlock = {
  type: string;
  elements?: TestBlockElement[];
  text?: { text: string };
};

type SlackBuilder = {
  buildBlocks: (data: ScorecardData) => TestSlackBlock[];
  buildFallbackText: (data: ScorecardData) => string;
  getSlackChannel: (data: ScorecardData) => "daily" | "fullrun" | "preview";
  getStatusColor: (data: ScorecardData) => "danger" | "good" | "warning";
};

const require = createRequire(import.meta.url);
const { buildBlocks, buildFallbackText, getSlackChannel, getStatusColor } = require(
  "../scripts/scorecard/build-slack-blocks.ts",
) as SlackBuilder;

function renderBlocks(data: ScorecardData): TestSlackBlock[] {
  return buildBlocks(data);
}

function elementText(block: TestSlackBlock | undefined, index: number): string {
  const text = block?.elements?.[index]?.text;
  return typeof text === "string" ? text : (text?.text ?? "");
}

function findRequiredBlock(
  blocks: TestSlackBlock[],
  predicate: (block: TestSlackBlock) => boolean,
): TestSlackBlock {
  const block = blocks.find(predicate);
  expect(block).toBeDefined();
  return block as TestSlackBlock;
}

function makeData(overrides: Partial<ScorecardData> = {}): ScorecardData {
  return {
    today: "May 25",
    runMode: "Scheduled full nightly",
    actor: "",
    isSelectiveDispatch: false,
    requestedJobs: [],
    total: 51,
    ran: 50,
    success: 50,
    failure: 0,
    cancelled: 0,
    skipped: 1,
    perfect: true,
    failedJobs: [],
    trendLine: "Trend: ↗️ Improving (yesterday had failures → today perfect)",
    runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
    ...overrides,
  };
}

describe("buildBlocks — perfect scheduled run", () => {
  const blocks = renderBlocks(makeData());

  it("starts with the run-mode context (title rendered outside via fallback text)", () => {
    expect(blocks[0]?.type).toBe("context");
    expect(blocks[0]?.elements).toHaveLength(1);
    expect(elementText(blocks[0], 0)).toContain("Scheduled full nightly");
  });

  it("does not include a header block inside the attachment", () => {
    expect(blocks.some((block) => block.type === "header")).toBe(false);
  });

  it("does not append an actor suffix for scheduled runs", () => {
    const withActor = renderBlocks(makeData({ actor: "hple" }));
    expect(elementText(withActor[0], 0)).not.toContain("(by");
  });

  it("leads the stats line with 'Total ran: <ran>/<total>'", () => {
    const statsSection = findRequiredBlock(
      blocks,
      (block) => block.type === "section" && block.text?.text?.startsWith("*Total ran:*") === true,
    );
    expect(statsSection.text?.text).toContain("*Total ran:* 50/51");
  });

  it("includes the perfect-run banner instead of a failed-jobs list", () => {
    const texts = blocks
      .filter((block) => block.type === "section")
      .flatMap((block) => (block.text ? [block.text.text] : []));
    expect(texts.join("\n")).toContain("All jobs passed");
    expect(JSON.stringify(blocks)).not.toContain("Failed jobs");
  });

  it("uses primary style for the 'View this run' button on perfect runs", () => {
    const actions = findRequiredBlock(blocks, (block) => block.type === "actions");
    expect(actions.elements?.[0]?.style).toBe("primary");
    expect(actions.elements?.[0]?.url).toBe(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
    );
  });

  it("links the second button to the workflow file (derived from runUrl)", () => {
    const actions = findRequiredBlock(blocks, (block) => block.type === "actions");
    expect(actions.elements?.[1]?.url).toBe(
      "https://github.com/NVIDIA/NemoClaw/actions/workflows/nightly-e2e.yaml",
    );
  });

  it("strips the 'Trend: ' prefix and re-bolds it", () => {
    const trendCtx = blocks.filter((block) => block.type === "context").pop();
    expect(elementText(trendCtx, 0)).toMatch(/^\*Trend:\*/);
    expect(elementText(trendCtx, 0)).not.toMatch(/^Trend: /);
  });
});

describe("buildBlocks — run with failures", () => {
  const blocks = renderBlocks(
    makeData({
      success: 47,
      failure: 3,
      perfect: false,
      failedJobs: [
        {
          name: "cloud-e2e",
          url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678/job/100",
        },
        {
          name: "issue-2478-crash-loop-recovery-e2e",
          url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678/job/101",
        },
        // url=null exercises the fallback rendering (no API result for this job)
        { name: "sandbox-operations-e2e", url: null },
      ],
      trendLine: "Trend: ↘️ Degrading (yesterday perfect → today has failures)",
    }),
  );

  it("renders a failed-jobs section with Slack hyperlinks where URLs are available", () => {
    const failedSection = findRequiredBlock(
      blocks,
      (block) => block.type === "section" && block.text?.text?.includes("Failed jobs") === true,
    );
    expect(failedSection.text?.text).toContain("Failed jobs (3)");
    // Hyperlinked entries use Slack mrkdwn `<url|text>` format.
    expect(failedSection.text?.text).toContain(
      "<https://github.com/NVIDIA/NemoClaw/actions/runs/12345678/job/100|cloud-e2e>",
    );
    // Fallback: when url is null, render as code-formatted name.
    expect(failedSection.text?.text).toContain("`sandbox-operations-e2e`");
  });

  it("does not include the perfect-run banner", () => {
    expect(JSON.stringify(blocks)).not.toContain("All jobs passed");
  });

  it("uses danger style for the 'View this run' button", () => {
    const actions = findRequiredBlock(blocks, (block) => block.type === "actions");
    expect(actions.elements?.[0]?.style).toBe("danger");
  });

  it("shows the failure count in the stats line", () => {
    const statsSection = findRequiredBlock(
      blocks,
      (block) => block.type === "section" && block.text?.text?.includes("*Failed:*") === true,
    );
    expect(statsSection.text?.text).toContain("*Failed:* 3");
  });
});

describe("buildBlocks — selective dispatch", () => {
  const blocks = renderBlocks(
    makeData({
      runMode: "Selective dispatch",
      isSelectiveDispatch: true,
      requestedJobs: ["cloud-e2e", "hermes-slack-e2e"],
      total: 2,
      ran: 2,
      success: 2,
      skipped: 0,
      trendLine: "Trend: ⊘ Not shown for selective dispatches",
    }),
  );

  it("adds a second context element listing the requested jobs", () => {
    expect(blocks[0]?.elements).toHaveLength(2);
    expect(elementText(blocks[0], 1)).toContain("`cloud-e2e`");
    expect(elementText(blocks[0], 1)).toContain("`hermes-slack-e2e`");
  });

  it("appends actor suffix on selective dispatch when actor is present", () => {
    const withActor = renderBlocks(
      makeData({
        runMode: "Selective dispatch",
        isSelectiveDispatch: true,
        requestedJobs: ["cloud-e2e"],
        actor: "hple",
      }),
    );
    expect(elementText(withActor[0], 0)).toContain("(by *hple*)");
  });

  it("keeps the 'not shown' trend text from the generator", () => {
    const trendCtx = blocks.filter((block) => block.type === "context").pop();
    expect(elementText(trendCtx, 0)).toContain("Not shown");
  });
});

describe("buildBlocks — manual full run with actor", () => {
  it("appends actor suffix in the run-mode context line", () => {
    const blocks = renderBlocks(
      makeData({ runMode: "Manual full run", actor: "hple" }),
    );
    expect(elementText(blocks[0], 0)).toContain("Manual full run (by *hple*)");
  });

  it("omits actor suffix when actor is empty", () => {
    const blocks = renderBlocks(
      makeData({ runMode: "Manual full run", actor: "" }),
    );
    expect(elementText(blocks[0], 0)).toBe("*Run mode:* Manual full run");
  });
});

describe("buildFallbackText", () => {
  it("renders schedule title with 🗓️ DAILY segment (uppercase)", () => {
    expect(buildFallbackText(makeData())).toBe(
      "🌅 *NemoClaw Nightly Scorecard · 🗓️ DAILY · May 25*",
    );
  });

  it("renders manual full title with 🛠 prefix + actor", () => {
    expect(
      buildFallbackText(makeData({ runMode: "Manual full run", actor: "hunglp6d" })),
    ).toBe("🌅 *NemoClaw Nightly Scorecard · 🛠 Manual full by hunglp6d · May 25*");
  });

  it("renders selective title with 🛠 prefix + actor", () => {
    expect(
      buildFallbackText(
        makeData({
          runMode: "Selective dispatch",
          isSelectiveDispatch: true,
          requestedJobs: ["cloud-e2e"],
          actor: "hunglp6d",
        }),
      ),
    ).toBe("🌅 *NemoClaw Nightly Scorecard · 🛠 Selective by hunglp6d · May 25*");
  });

  it("omits 'by <actor>' when actor empty on manual full", () => {
    expect(
      buildFallbackText(makeData({ runMode: "Manual full run", actor: "" })),
    ).toBe("🌅 *NemoClaw Nightly Scorecard · 🛠 Manual full · May 25*");
  });

  it("uses the same title regardless of run outcome (within same runMode)", () => {
    const perfect = buildFallbackText(makeData());
    const withFailures = buildFallbackText(makeData({ perfect: false, failure: 3 }));
    expect(perfect).toBe(withFailures);
  });
});

describe("getStatusColor", () => {
  it("returns 'good' (green) for a perfect run", () => {
    expect(getStatusColor(makeData())).toBe("good");
  });

  it("returns 'danger' (red) when any job failed", () => {
    expect(getStatusColor(makeData({ perfect: false, failure: 1 }))).toBe("danger");
  });

  it("returns 'warning' (yellow) when run is incomplete but had no failures", () => {
    expect(getStatusColor(makeData({ perfect: false, failure: 0, cancelled: 2 }))).toBe("warning");
  });

  it("prioritises 'danger' over 'good' if both failure>0 and perfect somehow set", () => {
    // Defensive: perfect should never be true with failures, but if input
    // is malformed we still surface the failure signal.
    expect(getStatusColor(makeData({ perfect: true, failure: 1 }))).toBe("danger");
  });
});

describe("getSlackChannel", () => {
  it("routes scheduled nightly runs to the daily channel", () => {
    expect(getSlackChannel(makeData())).toBe("daily");
  });

  it("routes manual full runs (workflow_dispatch, empty jobs) to the fullrun channel", () => {
    expect(getSlackChannel(makeData({ runMode: "Manual full run" }))).toBe("fullrun");
  });

  it("routes selective dispatches to the preview channel", () => {
    expect(
      getSlackChannel(
        makeData({
          runMode: "Selective dispatch",
          isSelectiveDispatch: true,
          requestedJobs: ["cloud-e2e"],
        }),
      ),
    ).toBe("preview");
  });
});
