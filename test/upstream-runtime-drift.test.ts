// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRuntimeDriftReport,
  createSlackPayload,
  type RuntimePins,
  readRuntimePins,
  renderMarkdownReport,
  type SourceResult,
  type UpstreamResponses,
} from "../scripts/checks/upstream-runtime-drift.mts";

const NOW = new Date("2026-07-30T18:00:00.000Z");
const NEMOCLAW_SHA = "a".repeat(40);
const PINS: RuntimePins = {
  openshell: { minimum: "0.0.85", maximum: "0.0.85" },
  openclaw: "2026.7.1",
  hermes: { tag: "v2026.7.20", version: "0.19.0" },
  deepAgentsCode: "0.1.34",
};

function source(data: unknown): SourceResult {
  return { data };
}

function githubRelease(tag: string, publishedAt: string) {
  return {
    draft: false,
    prerelease: false,
    published_at: publishedAt,
    tag_name: tag,
  };
}

function pypiFile(publishedAt: string) {
  return [{ upload_time_iso_8601: publishedAt }];
}

function githubIssue(
  number: number,
  title: string,
  labels: readonly string[],
  body = "",
  state: "closed" | "open" = "open",
) {
  return {
    body,
    html_url: `https://github.com/NVIDIA/NemoClaw/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    number,
    state,
    title,
  };
}

function currentResponses(): UpstreamResponses {
  return {
    openshell: source([githubRelease("v0.0.85", "2026-07-16T15:12:41Z")]),
    openclaw: source({
      "dist-tags": { latest: "2026.7.1" },
      time: { "2026.7.1": "2026-07-16T15:30:00Z" },
    }),
    hermesReleases: source([githubRelease("v2026.7.20", "2026-07-20T18:35:55Z")]),
    hermesPackage: source({ version: "0.19.0" }),
    deepAgentsCode: source({
      info: { version: "0.1.34" },
      releases: { "0.1.34": pypiFile("2026-07-16T16:00:00Z") },
    }),
    nemoclawCompatibilityIssue: source(
      githubIssue(6691, "Run speculative compatibility tests against candidate runtime versions", [
        "area: ci",
        "area: e2e",
      ]),
    ),
    nemoclawRecommendedBlockers: source({ items: [] }),
    nemoclawUnblockers: source({ items: [] }),
  };
}

function writeFixture(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe("nightly upstream runtime drift report", () => {
  it("reads the four authoritative runtime pins", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-drift-pins-"));
    try {
      writeFixture(
        root,
        "nemoclaw-blueprint/blueprint.yaml",
        'min_openshell_version: "0.0.85"\nmax_openshell_version: "0.0.85"\n',
      );
      writeFixture(root, "Dockerfile.base", "ARG OPENCLAW_VERSION=2026.7.1\n");
      writeFixture(
        root,
        "agents/hermes/Dockerfile.base",
        "ARG HERMES_VERSION=v2026.7.20\nARG HERMES_SEMVER=0.19.0\n",
      );
      writeFixture(
        root,
        "agents/langchain-deepagents-code/requirements.in",
        "deepagents-code[nvidia,openrouter]==0.1.34\n",
      );

      expect(readRuntimePins(root)).toEqual(PINS);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports matching stable releases as current", () => {
    const report = createRuntimeDriftReport({
      generatedAt: NOW,
      nemoclawSha: NEMOCLAW_SHA,
      pins: PINS,
      responses: currentResponses(),
    });

    expect(report.totals).toEqual({ current: 4, overdue: 0, review: 0, unknown: 0 });
    expect(report.priorityTotals).toEqual({
      investigate: 0,
      monitor: 4,
      stability: 0,
      updateness: 0,
      validation: 0,
    });
    expect(report.components.map(({ component, status }) => ({ component, status }))).toEqual([
      { component: "OpenShell", status: "current" },
      { component: "OpenClaw", status: "current" },
      { component: "Hermes", status: "current" },
      { component: "LangChain Deep Agents Code", status: "current" },
    ]);
    expect(report.components[0]?.caveat).toContain(
      "compatibility range deliberately sets min=max=0.0.85",
    );
  });

  it("separates review items from advisory threshold breaches", () => {
    const responses: UpstreamResponses = {
      ...currentResponses(),
      openshell: source([
        githubRelease("v0.0.92", "2026-07-27T15:32:25Z"),
        githubRelease("v0.0.91", "2026-07-24T15:06:36Z"),
        githubRelease("v0.0.85", "2026-07-16T15:12:41Z"),
      ]),
      openclaw: source({
        "dist-tags": { latest: "2026.7.1-1" },
        time: {
          "2026.7.1": "2026-07-16T15:30:00Z",
          "2026.7.1-1": "2026-07-29T15:30:00Z",
        },
      }),
      deepAgentsCode: source({
        info: { version: "0.1.40" },
        releases: Object.fromEntries(
          Array.from({ length: 7 }, (_, index) => [
            `0.1.${34 + index}`,
            pypiFile(`2026-07-${String(20 + index).padStart(2, "0")}T16:00:00Z`),
          ]),
        ),
      }),
    };

    const report = createRuntimeDriftReport({
      generatedAt: NOW,
      nemoclawSha: NEMOCLAW_SHA,
      pins: PINS,
      responses,
    });
    const byComponent = Object.fromEntries(
      report.components.map((component) => [component.component, component]),
    );

    expect(byComponent.OpenShell).toMatchObject({
      daysBehind: 6,
      latestUpstream: "0.0.92",
      releasesBehind: 2,
      status: "overdue",
    });
    expect(byComponent.OpenClaw).toMatchObject({
      daysBehind: 1,
      latestUpstream: "2026.7.1-1",
      releasesBehind: 1,
      status: "review",
    });
    expect(byComponent["LangChain Deep Agents Code"]).toMatchObject({
      latestUpstream: "0.1.40",
      priority: "updateness",
      releasesBehind: 6,
      status: "overdue",
    });
    expect(report.totals).toEqual({ current: 1, overdue: 2, review: 1, unknown: 0 });
  });

  it("contains invalid upstream metadata without copying it into notifications", () => {
    const responses: UpstreamResponses = {
      ...currentResponses(),
      openshell: source([githubRelease("<!channel>", "2026-07-30T17:00:00Z")]),
    };

    const report = createRuntimeDriftReport({
      generatedAt: NOW,
      nemoclawSha: NEMOCLAW_SHA,
      pins: PINS,
      responses,
    });
    const openshell = report.components[0];
    const slack = JSON.stringify(createSlackPayload(report));

    expect(openshell).toMatchObject({ latestUpstream: "unknown", status: "unknown" });
    expect(openshell?.caveat).toContain("release 0 has invalid tag");
    expect(slack).not.toContain("<!channel>");
  });

  it("treats missing blocker results as incomplete evidence instead of no blockers", () => {
    const responses: UpstreamResponses = {
      ...currentResponses(),
      openclaw: source({
        "dist-tags": { latest: "2026.7.1-1" },
        time: {
          "2026.7.1": "2026-07-16T15:30:00Z",
          "2026.7.1-1": "2026-07-29T15:30:00Z",
        },
      }),
      nemoclawRecommendedBlockers: { error: "HTTP 503" },
    };
    const report = createRuntimeDriftReport({
      generatedAt: NOW,
      nemoclawSha: NEMOCLAW_SHA,
      pins: PINS,
      responses,
    });
    const markdown = renderMarkdownReport(report);
    const openclaw = report.components.find((component) => component.component === "OpenClaw");

    expect(report.blockerEvidenceComplete).toBe(false);
    expect(openclaw?.priority).toBe("investigate");
    expect(markdown).toContain(
      "Pin Diesel could not collect complete public GitHub blocker evidence",
    );
    expect(markdown).toContain("Evidence collection warnings:");
    expect(markdown).not.toContain("No open public GitHub issues");
  });

  it("renders the requested inventory columns and a brief Slack summary", () => {
    const responses: UpstreamResponses = {
      ...currentResponses(),
      openshell: source([
        githubRelease("v0.0.92", "2026-07-27T15:32:25Z"),
        githubRelease("v0.0.91", "2026-07-24T15:06:36Z"),
        githubRelease("v0.0.85", "2026-07-16T15:12:41Z"),
      ]),
      nemoclawUnblockers: source({
        items: [
          githubIssue(
            6256,
            "security: verify runtime OpenShell version against credential boundary manifest",
            ["area: security", "needs: unblock"],
          ),
        ],
      }),
    };
    const report = createRuntimeDriftReport({
      generatedAt: NOW,
      nemoclawSha: NEMOCLAW_SHA,
      pins: PINS,
      responses,
    });
    const markdown = renderMarkdownReport(report);
    const payload = createSlackPayload(
      report,
      "https://github.com/NVIDIA/NemoClaw/actions/runs/12345",
    ) as {
      attachments: Array<{ blocks: Array<{ text?: { text?: string } }>; color: string }>;
      text: string;
    };

    expect(markdown.split("\n")[0]).toContain("Vibe check:");
    expect(markdown).toContain("# NemoClaw Pin Diesel — nightly dependency report");
    expect(markdown).toContain("| 🛡️ Validation gate | OpenShell |");
    expect(markdown).toContain("| Component | Latest upstream | NemoClaw pin | Caveats |");
    expect(markdown).toContain(
      "| OpenShell | 0.0.92 | 0.0.85 | 🔴 The compatibility range deliberately sets min=max=0.0.85.",
    );
    expect(markdown).toContain(
      "[#6256 — security: verify runtime OpenShell version against credential boundary manifest]",
    );
    expect(markdown).toContain("Pin Diesel is a deterministic reporter");
    expect(payload.text).toContain("NemoClaw Pin Diesel: 0 stability · 1 validation");
    expect(payload.attachments[0]?.color).toBe("#ECB22E");
    expect(payload.attachments[0]?.blocks[0]?.text?.text).toContain(
      "🛡️ *OpenShell* · Validation gate · `0.0.85` → `0.0.92`",
    );
    expect(JSON.stringify(payload)).toContain("Open deep report");
    expect(JSON.stringify(payload)).not.toContain("security: verify runtime");
  });

  it("requires explicit blocker text before classifying an update as stability work", () => {
    const responses: UpstreamResponses = {
      ...currentResponses(),
      openclaw: source({
        "dist-tags": { latest: "2026.7.1-1" },
        time: {
          "2026.7.1": "2026-07-16T15:30:00Z",
          "2026.7.1-1": "2026-07-29T15:30:00Z",
        },
      }),
      nemoclawRecommendedBlockers: source({
        items: [
          githubIssue(
            8001,
            "[OpenClaw] renderer regression blocks release",
            ["Recommended Blocker", "integration: openclaw"],
            "The regression is resolved by upgrading OpenClaw to 2026.7.1-1.",
          ),
        ],
      }),
    };
    const report = createRuntimeDriftReport({
      generatedAt: NOW,
      nemoclawSha: NEMOCLAW_SHA,
      pins: PINS,
      responses,
    });
    const openclaw = report.components.find((component) => component.component === "OpenClaw");

    expect(openclaw).toMatchObject({
      priority: "stability",
      blockers: [{ issue: 8001, relationship: "update-fix" }],
    });
    expect(report.verdict).toContain("upstream brought receipts");
  });
});
