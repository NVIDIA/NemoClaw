// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface TriageFixture {
  projectOutput: string;
  reviewDecisions?: Record<number, string>;
  approvedOnly?: boolean;
}

const requiredChecks = ["checks", "commit-lint", "dco-check"].map((name) => ({
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
}));

const pullRequests = [
  {
    number: 101,
    title: "Urgent Project item",
    url: "https://github.com/NVIDIA/NemoClaw/pull/101",
    author: { login: "one" },
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    isDraft: false,
    createdAt: "2099-01-01T00:00:00Z",
    updatedAt: "2099-01-01T00:00:00Z",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    labels: [],
    statusCheckRollup: [],
  },
  {
    number: 102,
    title: "High Project item",
    url: "https://github.com/NVIDIA/NemoClaw/pull/102",
    author: { login: "two" },
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    isDraft: false,
    createdAt: "2099-01-01T00:00:00Z",
    updatedAt: "2099-01-01T00:00:00Z",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    labels: [],
    statusCheckRollup: [],
  },
  {
    number: 103,
    title: "Legacy label only",
    url: "https://github.com/NVIDIA/NemoClaw/pull/103",
    author: { login: "three" },
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    isDraft: false,
    createdAt: "2099-01-01T00:00:00Z",
    updatedAt: "2099-01-01T00:00:00Z",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    labels: [{ name: "priority: high" }],
    statusCheckRollup: [],
  },
];

function runTriage(fixture: TriageFixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maintainer-triage-runtime-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const ghPath = path.join(bin, "gh");
  const config = {
    pullRequests,
    projectOutput: fixture.projectOutput,
    reviewDecisions: fixture.reviewDecisions ?? {
      101: "APPROVED",
      102: "APPROVED",
      103: "APPROVED",
    },
    requiredChecks,
  };

  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const config = ${JSON.stringify(config)};
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "--paginate" && args[2]?.startsWith("repos/NVIDIA/NemoClaw/pulls?")) {
  process.stdout.write(config.pullRequests.map(JSON.stringify).join("\\n"));
} else if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(config.projectOutput);
} else if (args[0] === "pr" && args[1] === "view") {
  const number = Number(args[2]);
  process.stdout.write(JSON.stringify({
    reviewDecision: config.reviewDecisions[number] ?? "",
    statusCheckRollup: config.requiredChecks,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
  }));
} else if (args[0] === "api" && args[1]?.startsWith("repos/NVIDIA/NemoClaw/pulls/") && args[1]?.includes("/files?")) {
  process.stdout.write("[]");
} else {
  process.stderr.write(\`unexpected gh args: \${args.join(" ")}\\n\`);
  process.exit(9);
}
`,
  );
  fs.chmodSync(ghPath, 0o755);

  const args = [
    "--experimental-strip-types",
    "--no-warnings",
    ".agents/skills/nemoclaw-maintainer-day/scripts/triage.ts",
    "--limit",
    "10",
    ...(fixture.approvedOnly ? ["--approved-only"] : []),
  ];

  try {
    return spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("maintainer triage runtime behavior", () => {
  it("maps live Project Priority into scoring and ignores legacy priority labels", () => {
    const result = runTriage({
      projectOutput: [
        { number: 101, repository: "NVIDIA/NemoClaw", priority: "Urgent" },
        { number: 102, repository: "NVIDIA/NemoClaw", priority: "High" },
        { number: 103, repository: "another/repository", priority: "High" },
        { number: null, repository: "NVIDIA/NemoClaw", priority: "Urgent" },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.queue.map((item: { number: number }) => item.number)).toEqual([101, 102, 103]);
    expect(output.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 101, projectPriority: "Urgent", score: 55 }),
        expect.objectContaining({ number: 102, projectPriority: "High", score: 50 }),
        expect.objectContaining({ number: 103, projectPriority: null, score: 40 }),
      ]),
    );
  });

  it("applies --approved-only after review decisions are enriched", () => {
    const result = runTriage({
      projectOutput: "",
      reviewDecisions: { 101: "APPROVED", 102: "REVIEW_REQUIRED", 103: "" },
      approvedOnly: true,
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.scanned).toBe(3);
    expect(output.queue.map((item: { number: number }) => item.number)).toEqual([101]);
    expect(output.nearMisses).toEqual([]);
  });

  it("reports malformed Project data and continues without priority boosts", () => {
    const result = runTriage({ projectOutput: "not-json" });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "Could not parse Project 199 item data; continuing without priority boosts.",
    );
    const output = JSON.parse(result.stdout);
    expect(output.queue).toHaveLength(3);
    expect(
      output.queue.every(
        (item: { projectPriority: string | null }) => item.projectPriority === null,
      ),
    ).toBe(true);
  });
});
