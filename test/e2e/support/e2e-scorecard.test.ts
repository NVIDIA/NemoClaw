// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ScorecardData } from "../../../scripts/scorecard/build-slack-blocks.ts";

const require = createRequire(import.meta.url);
const slack = require("../../../scripts/scorecard/build-slack-blocks.ts") as {
  buildBlocks: (data: ScorecardData) => Array<{
    elements?: Array<{ text?: { text?: string }; url?: string }>;
    text?: { text: string };
    type: string;
  }>;
  buildFallbackText: (data: ScorecardData) => string;
  getSlackChannel: (data: ScorecardData) => string;
};
const trace = require("../../../scripts/scorecard/analyze-trace-timing.ts") as {
  buildPhaseRows: (
    current: Record<string, number>,
    previous: Record<string, number>,
  ) => Array<{ label: string }>;
  buildTraceSummaryLines: (
    current: { totalMs: number },
    previous: { totalMs: number },
    tag: { name: string },
    rows: Array<{ label: string }>,
  ) => string[];
  formatTopPhaseChanges: (rows: Array<{ label: string }>) => string;
  selectOnboardTrace: (texts: string[]) => { totalMs: number } | null;
};
const SANITIZER = "scripts/e2e/sanitize-trace-timing.py";

function makeRawTrace(): Record<string, unknown> {
  return {
    resource_spans: [
      {
        scope_spans: [
          {
            spans: [
              { name: "nemoclaw.onboard", duration_ms: 1200 },
              {
                name: "nemoclaw.onboard.phase.preflight",
                duration_ms: 500,
                attributes: { api_key: "nvapi-should-never-appear" },
                events: [{ name: "prompt", attributes: { value: "secret" } }],
              },
            ],
          },
        ],
      },
    ],
    summary: {
      trace_id: "0123456789abcdef0123456789abcdef",
      total_duration_ms: 1200,
      output_path: "/tmp/raw-trace.json",
      slowest_spans: [
        {
          name: "nemoclaw.onboard.phase.preflight",
          duration_ms: 500,
          status: "OK",
        },
      ],
    },
  };
}

function runSanitizer(source: string, output: string) {
  return spawnSync("python3", [SANITIZER, source, output], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function scorecardData(overrides: Partial<ScorecardData> = {}): ScorecardData {
  return {
    today: "Jun 29",
    runMode: "Scheduled E2E",
    actor: "",
    isSelectiveDispatch: false,
    requestedJobs: [],
    requestedTargets: [],
    total: 58,
    ran: 58,
    success: 58,
    failure: 0,
    cancelled: 0,
    skipped: 0,
    perfect: true,
    failedJobs: [],
    traceTimingLine: "Trace: cloud-onboard total 2m 1.0s",
    runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/123",
    ...overrides,
  };
}

describe("E2E scorecard", () => {
  it("routes scheduled, full, and opt-in selective summaries to distinct Slack channels", () => {
    expect(slack.getSlackChannel(scorecardData())).toBe("daily");
    expect(slack.getSlackChannel(scorecardData({ runMode: "Manual full run" }))).toBe("fullrun");
    expect(
      slack.getSlackChannel(
        scorecardData({
          runMode: "Selective dispatch",
          isSelectiveDispatch: true,
          requestedJobs: ["cloud-onboard"],
        }),
      ),
    ).toBe("preview");
  });

  it("links Slack summaries to the consolidated workflow", () => {
    const data = scorecardData();
    const actions = slack.buildBlocks(data).find((block) => block.type === "actions");
    expect(actions?.elements?.[1]?.url).toBe(
      "https://github.com/NVIDIA/NemoClaw/actions/workflows/e2e.yaml",
    );
    expect(slack.buildFallbackText(data)).toContain("NemoClaw E2E Scorecard");

    const failureUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/456";
    const failureSection = slack
      .buildBlocks(
        scorecardData({
          failure: 1,
          perfect: false,
          failedJobs: [{ name: "live (openclaw-nvidia)", url: failureUrl }],
        }),
      )
      .find((block) => block.text?.text.includes("Failed jobs"));
    expect(failureSection?.text?.text).toContain(`<${failureUrl}|live (openclaw-nvidia)>`);
  });

  it("compares only allowlisted onboard timing phases", () => {
    const rows = trace.buildPhaseRows(
      {
        "nemoclaw.onboard.phase.preflight": 1_000,
        "nemoclaw.onboard.phase.gateway": 5_000,
        "nemoclaw.onboard.phase.future": 100_000,
      },
      {
        "nemoclaw.onboard.phase.preflight": 2_000,
        "nemoclaw.onboard.phase.gateway": 3_000,
        "nemoclaw.onboard.phase.future": 1,
      },
    );
    expect(rows.map((row) => row.label)).toEqual(["preflight", "gateway"]);
    expect(trace.formatTopPhaseChanges(rows)).toBe("gateway +2.0s; preflight -1.0s");
    expect(
      trace
        .buildTraceSummaryLines({ totalMs: 6_000 }, { totalMs: 5_000 }, { name: "v0.0.69" }, rows)
        .join("\n"),
    ).toContain("latest completed `e2e.yaml` run");
  });

  it("accepts only the trusted timing-summary schema", () => {
    const good = JSON.stringify({
      schema_version: "nemoclaw.trace_timing.v1",
      total_duration_ms: 1000,
      phases: { "nemoclaw.onboard.phase.preflight": 500 },
    });
    const rawTrace = JSON.stringify({
      summary: { total_duration_ms: 9999 },
      resource_spans: [{ scope_spans: [{ spans: [] }] }],
    });
    expect(trace.selectOnboardTrace([rawTrace])).toBeNull();
    expect(trace.selectOnboardTrace([good])?.totalMs).toBe(1000);
  });

  it("sanitizes raw traces into a timing-only artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-sanitize-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    const rawPath = join(source, "trace.json");
    try {
      mkdirSync(source);
      mkdirSync(output);
      writeFileSync(join(output, "existing-artifact.log"), "preserve me\n");
      writeFileSync(rawPath, JSON.stringify(makeRawTrace()));
      writeFileSync(join(source, "environment.txt"), "NVIDIA_API_KEY=nvapi-secret\n");
      writeFileSync(
        join(source, "malicious.json"),
        JSON.stringify({ summary: { total_duration_ms: 9999 }, token: "ghp_secret" }),
      );
      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);
      const summaryPath = join(output, "cloud-onboard-trace-timing-summary.json");
      const summary = readFileSync(summaryPath, "utf8");
      expect(readFileSync(join(output, "existing-artifact.log"), "utf8")).toBe("preserve me\n");
      expect(JSON.parse(summary)).toEqual({
        phases: { "nemoclaw.onboard.phase.preflight": 500 },
        schema_version: "nemoclaw.trace_timing.v1",
        slowest_spans: [
          { duration_ms: 500, name: "nemoclaw.onboard.phase.preflight", status: "OK" },
        ],
        total_duration_ms: 1200,
        trace_id: "0123456789abcdef0123456789abcdef",
      });
      expect(summary).not.toMatch(/api_key|nvapi|ghp_|attributes|events|output_path|raw-trace/u);
      expect(lstatSync(summaryPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("emits no timing summary for malformed or non-onboard traces", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-invalid-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    try {
      mkdirSync(source);
      writeFileSync(join(source, "malformed.json"), "{not-json");
      writeFileSync(
        join(source, "not-onboard.json"),
        JSON.stringify({ resource_spans: [], summary: { total_duration_ms: 1 } }),
      );
      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(output)).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects symlinked trace sources and trusted output paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-symlink-"));
    const source = join(directory, "raw");
    const sourceLink = join(directory, "raw-link");
    const outputTarget = join(directory, "target-controlled");
    const outputLink = join(directory, "trusted-link");
    try {
      mkdirSync(source);
      mkdirSync(outputTarget);
      writeFileSync(join(source, "trace.json"), JSON.stringify(makeRawTrace()));
      writeFileSync(join(outputTarget, "secret.txt"), "do not overwrite\n");
      symlinkSync(source, sourceLink, "dir");
      symlinkSync(outputTarget, outputLink, "dir");

      const sourceResult = runSanitizer(sourceLink, join(directory, "trusted"));
      expect(sourceResult.status).toBe(2);
      expect(sourceResult.stderr).toContain("trace source must not be a symlink");

      const outputResult = runSanitizer(source, outputLink);
      expect(outputResult.status).toBe(2);
      expect(outputResult.stderr).toContain("trusted output must be a real directory");
      expect(readFileSync(join(outputTarget, "secret.txt"), "utf8")).toBe("do not overwrite\n");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses to follow a pre-created timing-summary symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-file-symlink-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    const target = join(directory, "target-controlled.txt");
    try {
      mkdirSync(source);
      mkdirSync(output);
      writeFileSync(join(source, "trace.json"), JSON.stringify(makeRawTrace()));
      writeFileSync(target, "do not overwrite\n");
      symlinkSync(target, join(output, "cloud-onboard-trace-timing-summary.json"));

      const result = runSanitizer(source, output);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("trusted timing summary must not be a symlink");
      expect(readFileSync(target, "utf8")).toBe("do not overwrite\n");
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
