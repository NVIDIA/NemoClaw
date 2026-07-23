// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/docs-review-receipt.mts";
const HEAD_SHA = "a".repeat(40);
const AGENTS_BLOB_SHA = "b".repeat(40);

function receipt(overrides: Partial<Record<string, string>> = {}): string {
  const values = {
    checked: "x",
    result: "`docs-updated`",
    evidence: "Updated docs/get-started/quickstart.mdx.",
    agent: "Codex",
    prNumber: "#42",
    headSha: HEAD_SHA.slice(0, 12),
    agentsSha: AGENTS_BLOB_SHA.slice(0, 12),
    ...overrides,
  };
  return `## Documentation Writer Review

- [${values.checked}] Documentation writer subagent reviewed the completed changes
- Result: ${values.result}
- Evidence: ${values.evidence}
- Agent: ${values.agent}
- PR: ${values.prNumber}
<!-- docs-review-head-sha: ${values.headSha} -->
<!-- docs-review-agents-blob-sha: ${values.agentsSha} -->
`;
}

function runCheck(
  body: string,
  changedFiles: string[],
  options: { agentsBlob?: string; mode?: "advisory" | "required" } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "docs-review-receipt-"));
  const eventPath = path.join(directory, "event.json");
  const changedFilesPath = path.join(directory, "changed-files.txt");
  const summaryPath = path.join(directory, "summary.md");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 42,
        html_url: "https://github.com/NVIDIA/NemoClaw/pull/42",
        body,
        head: { sha: HEAD_SHA },
      },
    }),
  );
  fs.writeFileSync(changedFilesPath, `${changedFiles.join("\n")}\n`);

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        SCRIPT,
        "check",
        "--event",
        eventPath,
        "--changed-files",
        changedFilesPath,
        "--agents-blob",
        options.agentsBlob ?? AGENTS_BLOB_SHA,
        "--mode",
        options.mode ?? "advisory",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
      },
    );
    return {
      ...result,
      output: result.stdout ? JSON.parse(result.stdout) : null,
      summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("documentation writer review receipt", () => {
  it("accepts a fresh receipt for a code and documentation change", () => {
    const result = runCheck(receipt(), ["src/lib/example.ts", "docs/get-started/quickstart.mdx"]);

    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({
      status: "valid",
      result: "docs-updated",
      agent: "Codex",
      prNumber: 42,
      prNumberMatches: true,
      headShaMatches: true,
      agentsShaMatches: true,
      issues: [],
    });
    expect(result.summary).toContain("Status: `valid`");
  });

  it("reports a missing receipt without blocking advisory mode", () => {
    const result = runCheck("## Summary\n\nChange the CLI.\n", ["src/lib/example.ts"]);

    expect(result.status).toBe(0);
    expect(result.output.status).toBe("missing");
    expect(result.stderr).toContain("change code or documentation must include");
  });

  it("fails required mode when a code change has no receipt", () => {
    const result = runCheck("## Summary\n\nChange the CLI.\n", ["src/lib/example.ts"], {
      mode: "required",
    });

    expect(result.status).toBe(1);
    expect(result.output.status).toBe("missing");
  });

  it("accepts a fresh receipt for a documentation-only change", () => {
    const result = runCheck(receipt(), ["README.md", "docs/index.mdx"]);

    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({
      status: "valid",
      codeChanged: false,
      docsChanged: true,
    });
    expect(result.output.issues).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("reports a missing receipt for a documentation-only change", () => {
    const result = runCheck("## Summary\n\nUpdate prose.\n", ["docs/index.mdx"]);

    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({
      status: "missing",
      codeChanged: false,
      docsChanged: true,
    });
    expect(result.stderr).toContain("change code or documentation must include");
  });

  it("fails required mode when a documentation-only change has no receipt", () => {
    const result = runCheck("## Summary\n\nUpdate prose.\n", ["docs/index.mdx"], {
      mode: "required",
    });

    expect(result.status).toBe(1);
    expect(result.output.status).toBe("missing");
  });

  it("requires a receipt for an MDX file outside docs", () => {
    const result = runCheck("## Summary\n\nUpdate prose.\n", ["examples/guide.mdx"]);

    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({
      status: "missing",
      codeChanged: false,
      docsChanged: true,
    });
    expect(result.stderr).toContain("change code or documentation must include");
  });

  it("accepts the completed-implementation wording in historical receipts", () => {
    const result = runCheck(
      receipt().replace("reviewed the completed changes", "reviewed the completed implementation"),
      ["src/lib/example.ts", "docs/index.mdx"],
    );

    expect(result.output.status).toBe("valid");
  });

  it("rejects repeated singleton receipt fields", () => {
    const body = receipt().replace(
      "- Result: `docs-updated`",
      "- Result: `docs-updated`\n- Result: `no-docs-needed`",
    );
    const result = runCheck(body, ["src/lib/example.ts", "docs/index.mdx"]);

    expect(result.output.status).toBe("invalid");
    expect(result.output.issues).toContain(
      "The Documentation Writer Review section repeats singleton fields: Result.",
    );
  });

  it("rejects repeated review completion checkboxes", () => {
    const body = receipt().replace(
      "- [x] Documentation writer subagent reviewed the completed changes",
      [
        "- [ ] Documentation writer subagent reviewed the completed changes",
        "- [x] Documentation writer subagent reviewed the completed changes",
      ].join("\n"),
    );
    const result = runCheck(body, ["src/lib/example.ts", "docs/index.mdx"]);

    expect(result.output.status).toBe("invalid");
    expect(result.output.issues).toContain(
      "The Documentation Writer Review section repeats singleton fields: review completion checkbox.",
    );
  });

  it("reports a copied PR number and stale head and AGENTS.md revisions", () => {
    const result = runCheck(
      receipt({
        result: "`no-docs-needed`",
        evidence: "The change affects an internal test helper only.",
        prNumber: "#41",
        headSha: "c".repeat(12),
        agentsSha: "d".repeat(12),
      }),
      ["test/example.test.ts"],
    );

    expect(result.output.status).toBe("invalid");
    expect(result.output.issues).toEqual(
      expect.arrayContaining([
        "The receipt PR number does not match this pull request.",
        "The documentation writer review is stale after a new commit.",
        "The reviewed AGENTS.md blob SHA does not match the pull request version.",
      ]),
    );
  });

  it("requires a documentation path for docs-updated", () => {
    const result = runCheck(receipt(), ["src/lib/example.ts"]);

    expect(result.output.status).toBe("invalid");
    expect(result.output.issues).toContain(
      "The docs-updated result requires a changed Markdown or docs/ file.",
    );
  });

  it("rejects the unmodified PR template fields", () => {
    const result = runCheck(
      receipt({
        checked: " ",
        result: "`docs-updated` | `no-docs-needed` | `blocked`",
        evidence: "",
        agent: "<Codex | Claude Code | Cursor | other>",
        prNumber: "#<number>",
        headSha: "",
        agentsSha: "",
      }),
      ["src/lib/example.ts"],
    );

    expect(result.output.status).toBe("invalid");
    expect(result.output.issues).toHaveLength(7);
  });
});

describe("documentation writer review report", () => {
  it("summarizes eligible PRs and emits CSV records", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "docs-review-report-"));
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin);
    const ghPath = path.join(bin, "gh");
    const pullRequests = [
      {
        number: 1,
        url: "https://github.com/NVIDIA/NemoClaw/pull/1",
        state: "MERGED",
        isDraft: false,
        author: { login: "engineer" },
        createdAt: "2026-06-13T00:00:00Z",
        mergedAt: "2026-06-14T00:00:00Z",
        headRefOid: HEAD_SHA,
        body: `## Type of Change

- [x] Code change with doc updates

${receipt({ evidence: "=1+1", prNumber: "#1" })}`,
        files: [{ path: "src/lib/example.ts" }, { path: "docs/index.mdx" }],
      },
      {
        number: 2,
        url: "https://github.com/NVIDIA/NemoClaw/pull/2",
        state: "OPEN",
        isDraft: true,
        author: { login: "engineer" },
        createdAt: "2026-06-15T00:00:00Z",
        mergedAt: null,
        headRefOid: "c".repeat(40),
        body: `## Type of Change

- [x] Code change (feature, bug fix, or refactor)
`,
        files: [{ path: "src/lib/other.ts" }],
      },
      {
        number: 3,
        url: "https://github.com/NVIDIA/NemoClaw/pull/3",
        state: "MERGED",
        isDraft: false,
        author: { login: "writer" },
        createdAt: "2026-06-16T00:00:00Z",
        mergedAt: "2026-06-17T00:00:00Z",
        headRefOid: "d".repeat(40),
        body: `## Type of Change

- [x] Doc only (prose changes, no code sample modifications)
`,
        files: [{ path: "docs/index.mdx" }],
      },
    ];
    fs.writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
printf '%s' '${JSON.stringify(pullRequests)}'
`,
    );
    fs.chmodSync(ghPath, 0o755);

    try {
      const jsonResult = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          SCRIPT,
          "report",
          "--since",
          "2026-06-12",
          "--until",
          "2026-06-12",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        },
      );
      const report = JSON.parse(jsonResult.stdout);
      expect(jsonResult.status).toBe(0);
      expect(report.metrics).toEqual({
        totalPrs: 3,
        eligiblePrs: 3,
        eligibleCodePrs: 2,
        eligibleDocsOnlyPrs: 1,
        unclassifiedPrs: 0,
        recordedReceipts: 1,
        receiptCoverage: 0.3333,
        validReceipts: 1,
        validReceiptRate: 0.3333,
        freshReceipts: 1,
        freshReceiptRate: 1,
        results: { blocked: 0, "docs-updated": 1, "no-docs-needed": 0 },
        agents: { codex: 1 },
      });

      const csvResult = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          SCRIPT,
          "report",
          "--since",
          "2026-06-12",
          "--until",
          "2026-06-12",
          "--format",
          "csv",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        },
      );
      expect(csvResult.status).toBe(0);
      expect(csvResult.stdout).toContain("receipt_status");
      expect(csvResult.stdout).toContain("1,https://github.com/NVIDIA/NemoClaw/pull/1");
      expect(csvResult.stdout).toContain("2,https://github.com/NVIDIA/NemoClaw/pull/2");
      expect(csvResult.stdout).toContain("'=1+1");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
