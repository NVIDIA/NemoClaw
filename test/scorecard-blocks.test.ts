// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  buildBlocks,
  buildFallbackText,
  getStatusColor,
} = require("../scripts/scorecard/build-slack-blocks.js");

type ScorecardData = {
  today: string;
  runMode: string;
  isSelectiveDispatch: boolean;
  requestedJobs: string[];
  total: number;
  ran: number;
  success: number;
  failure: number;
  cancelled: number;
  skipped: number;
  perfect: boolean;
  failedJobs: string[];
  trendLine: string;
  runUrl: string;
};

function makeData(overrides: Partial<ScorecardData> = {}): ScorecardData {
  return {
    today: "May 25",
    runMode: "Scheduled full nightly",
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
    trendLine:
      "Trend: ↗️ Improving (yesterday had failures → today perfect)",
    runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
    ...overrides,
  };
}

describe("buildBlocks — perfect scheduled run", () => {
  const blocks = buildBlocks(makeData());

  it("starts with the run-mode context (title rendered outside via fallback text)", () => {
    expect(blocks[0].type).toBe("context");
    expect(blocks[0].elements).toHaveLength(1);
    expect(blocks[0].elements[0].text).toContain("Scheduled full nightly");
  });

  it("does not include a header block inside the attachment", () => {
    expect(blocks.some((b: { type: string }) => b.type === "header")).toBe(false);
  });

  it("includes the perfect-run banner instead of a failed-jobs list", () => {
    const texts = blocks
      .filter((b: { type: string }) => b.type === "section")
      .flatMap((b: { text?: { text: string } }) => (b.text ? [b.text.text] : []));
    expect(texts.join("\n")).toContain("All jobs passed");
    expect(JSON.stringify(blocks)).not.toContain("Failed jobs");
  });

  it("uses primary style for the 'View this run' button on perfect runs", () => {
    const actions = blocks.find((b: { type: string }) => b.type === "actions");
    expect(actions.elements[0].style).toBe("primary");
    expect(actions.elements[0].url).toBe(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
    );
  });

  it("links the second button to the workflow file (derived from runUrl)", () => {
    const actions = blocks.find((b: { type: string }) => b.type === "actions");
    expect(actions.elements[1].url).toBe(
      "https://github.com/NVIDIA/NemoClaw/actions/workflows/nightly-e2e.yaml",
    );
  });

  it("strips the 'Trend: ' prefix and re-bolds it", () => {
    const trendCtx = blocks
      .filter((b: { type: string }) => b.type === "context")
      .pop();
    expect(trendCtx.elements[0].text).toMatch(/^\*Trend:\*/);
    expect(trendCtx.elements[0].text).not.toMatch(/^Trend: /);
  });
});

describe("buildBlocks — run with failures", () => {
  const blocks = buildBlocks(
    makeData({
      success: 47,
      failure: 3,
      perfect: false,
      failedJobs: [
        "cloud-e2e",
        "issue-2478-crash-loop-recovery-e2e",
        "sandbox-operations-e2e",
      ],
      trendLine:
        "Trend: ↘️ Degrading (yesterday perfect → today has failures)",
    }),
  );

  it("renders a failed-jobs section listing each job", () => {
    const failedSection = blocks.find(
      (b: { type: string; text?: { text: string } }) =>
        b.type === "section" && b.text?.text?.includes("Failed jobs"),
    );
    expect(failedSection).toBeDefined();
    expect(failedSection.text.text).toContain("Failed jobs (3)");
    expect(failedSection.text.text).toContain("`cloud-e2e`");
    expect(failedSection.text.text).toContain("`sandbox-operations-e2e`");
  });

  it("does not include the perfect-run banner", () => {
    expect(JSON.stringify(blocks)).not.toContain("All jobs passed");
  });

  it("uses danger style for the 'View this run' button", () => {
    const actions = blocks.find((b: { type: string }) => b.type === "actions");
    expect(actions.elements[0].style).toBe("danger");
  });

  it("shows the failure count in the stats line", () => {
    const statsSection = blocks.find(
      (b: { type: string; text?: { text: string } }) =>
        b.type === "section" && b.text?.text?.includes("*Failed:*"),
    );
    expect(statsSection.text.text).toContain("*Failed:* 3");
  });
});

describe("buildBlocks — selective dispatch", () => {
  const blocks = buildBlocks(
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
    expect(blocks[0].elements).toHaveLength(2);
    expect(blocks[0].elements[1].text).toContain("`cloud-e2e`");
    expect(blocks[0].elements[1].text).toContain("`hermes-slack-e2e`");
  });

  it("keeps the 'not shown' trend text from the generator", () => {
    const trendCtx = blocks
      .filter((b: { type: string }) => b.type === "context")
      .pop();
    expect(trendCtx.elements[0].text).toContain("Not shown");
  });
});

describe("buildFallbackText", () => {
  it("renders title with date and sunrise emoji", () => {
    expect(buildFallbackText(makeData())).toBe(
      "🌅 *NemoClaw Nightly Scorecard — May 25*",
    );
  });

  it("uses the same title regardless of run outcome", () => {
    // Title is now stable — status detail lives inside the attachment
    // stats line. Notification preview shows the title; users click to
    // see the breakdown.
    const perfect = buildFallbackText(makeData());
    const withFailures = buildFallbackText(
      makeData({ perfect: false, failure: 3 }),
    );
    expect(perfect).toBe(withFailures);
  });
});

describe("getStatusColor", () => {
  it("returns 'good' (green) for a perfect run", () => {
    expect(getStatusColor(makeData())).toBe("good");
  });

  it("returns 'danger' (red) when any job failed", () => {
    expect(
      getStatusColor(makeData({ perfect: false, failure: 1 })),
    ).toBe("danger");
  });

  it("returns 'warning' (yellow) when run is incomplete but had no failures", () => {
    expect(
      getStatusColor(
        makeData({ perfect: false, failure: 0, cancelled: 2 }),
      ),
    ).toBe("warning");
  });

  it("prioritises 'danger' over 'good' if both failure>0 and perfect somehow set", () => {
    // Defensive: perfect should never be true with failures, but if input
    // is malformed we still surface the failure signal.
    expect(
      getStatusColor(makeData({ perfect: true, failure: 1 })),
    ).toBe("danger");
  });
});
