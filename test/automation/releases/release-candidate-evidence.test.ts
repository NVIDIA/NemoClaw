// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalAuditReceipt,
  createAuditReceipt,
  sha256,
} from "../../../scripts/lib/npm-audit-receipt.mts";

const repositoryRoot = process.cwd();
const evidencePath = path.join(
  repositoryRoot,
  ".agents/skills/nemoclaw-maintainer-cut-release-tag/references/candidate-evidence.md",
);
const evidence = fs.readFileSync(evidencePath, "utf8");

function bashBlockUnder(source: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = new RegExp(
    `^${escapedHeading}\\n(?:(?!^## |^\`\`\`)[\\s\\S])*^\`\`\`bash\\n([\\s\\S]*?)^\`\`\`\\s*$`,
    "mu",
  ).exec(source)?.[1];
  return (
    block ??
    (() => {
      throw new Error(`candidate-evidence.md is missing a bash block under ${heading}`);
    })()
  );
}

function bashBlockContaining(source: string, marker: string): string {
  const blocks = [...source.matchAll(/^```bash\n([\s\S]*?)^```\s*$/gmu)].map(
    (match) => match[1] ?? "",
  );
  return (
    blocks.find((block) => block.includes(marker)) ??
    (() => {
      throw new Error(`candidate-evidence.md is missing a bash block containing ${marker}`);
    })()
  );
}

const planReadBlock = bashBlockContaining(evidence, 'PLAN_FIELDS="$EVIDENCE_DIR/plan-fields.txt"');
const releaseEntryBlock = bashBlockUnder(evidence, "## Release Entry and Documentation Coverage");
const docsPrSelectionBlock = bashBlockContaining(evidence, 'SELECTED_DOCS_PR="$EVIDENCE_DIR');
const docsPrReadBlock = bashBlockContaining(evidence, 'DOCS_PR_COMMITS="$EVIDENCE_DIR');
const auditReuseBlock = bashBlockUnder(evidence, "### Check Audit Receipt Reuse");
const temporaryDirectories: string[] = [];

const shellHelpers = String.raw`
set -euo pipefail
run_or_stop() {
  local label="$1"
  local status
  shift
  if "$@"; then
    return 0
  else
    status=$?
    printf '%s failed with status %s\n' "$label" "$status" >&2
    exit "$status"
  fi
}
stop() {
  printf '%s\n' "$1" >&2
  exit 1
}
`;

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function fixture(contents: Record<string, string>): {
  candidate: string;
  evidenceDir: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-candidate-evidence-"));
  temporaryDirectories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  for (const [file, content] of Object.entries(contents)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "docs: add changelog fixture");
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir);
  return { candidate: git(root, "rev-parse", "HEAD"), evidenceDir, root };
}

function runReleaseEntry(
  input: ReturnType<typeof fixture>,
  version = "v1.2.3",
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", `${shellHelpers}\n${releaseEntryBlock}`], {
    cwd: input.root,
    encoding: "utf8",
    env: {
      ...process.env,
      CANDIDATE_SHA: input.candidate,
      CANDIDATE_SELECTION: "current-main",
      EVIDENCE_DIR: input.evidenceDir,
      HISTORICAL_CANDIDATE_EXCEPTION: "None",
      VERSION: version,
    },
  });
}

function selectionFixture() {
  const input = fixture({ "docs/changelog/2026-08-17.mdx": "# Releases\n" });
  const previousTagSha = input.candidate;
  git(input.root, "commit", "--allow-empty", "-m", "docs: merge cumulative documentation");
  const ancestorMergeSha = git(input.root, "rev-parse", "HEAD");
  git(input.root, "commit", "--allow-empty", "-m", "feat: finish release candidate");
  input.candidate = git(input.root, "rev-parse", "HEAD");
  git(input.root, "checkout", "-b", "unrelated", previousTagSha);
  git(input.root, "commit", "--allow-empty", "-m", "docs: unrelated documentation");
  const nonAncestorMergeSha = git(input.root, "rev-parse", "HEAD");
  git(input.root, "checkout", "main");
  return { ancestorMergeSha, input, nonAncestorMergeSha, previousTagSha };
}

function docsCandidate(number: number, mergeSha: string): Record<string, unknown> {
  return {
    headRefName: `automation/post-merge-docs-${number}`,
    headRefOid: String(number).padStart(40, "0"),
    headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
    mergeCommit: { oid: mergeSha },
    mergedAt: "2026-08-20T12:00:00Z",
    number,
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        conclusion: "SUCCESS",
        name: "docs",
        status: "COMPLETED",
      },
    ],
    title: `docs: prepare v1.2.${number} documentation`,
    url: `https://github.com/NVIDIA/NemoClaw/pull/${number}`,
  };
}

function runDocsPrSelection(
  selection: ReturnType<typeof selectionFixture>,
  candidates: readonly Record<string, unknown>[],
  files: readonly Record<string, unknown>[] = [{ filename: "docs/guide.mdx" }],
): ReturnType<typeof spawnSync> {
  const { input, previousTagSha } = selection;
  fs.writeFileSync(
    path.join(input.evidenceDir, "managed-docs-pr-candidates.jsonl"),
    candidates
      .map((candidate) => JSON.stringify(candidate))
      .concat("")
      .join("\n"),
  );
  const bin = path.join(input.root, "bin");
  fs.mkdirSync(bin);
  const callLog = path.join(input.evidenceDir, "gh-calls.txt");
  fs.writeFileSync(callLog, "");
  const fakeGh = path.join(bin, "gh");
  fs.writeFileSync(
    fakeGh,
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_CALL_LOG"
case "$*" in
  *"/commits?"*) printf '%s\n' "$GH_COMMITS_JSON" ;;
  *"/files?"*) printf '%s\n' "$GH_FILES_JSON" ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  const commitMessage =
    "docs: catch up after main\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
  return spawnSync("bash", ["-c", `${shellHelpers}\n${docsPrSelectionBlock}\n${docsPrReadBlock}`], {
    cwd: input.root,
    encoding: "utf8",
    env: {
      ...process.env,
      CANDIDATE_SHA: input.candidate,
      EVIDENCE_DIR: input.evidenceDir,
      GH_CALL_LOG: callLog,
      GH_COMMITS_JSON: JSON.stringify([
        [
          {
            sha: "1".repeat(40),
            commit: {
              author: { email: "41898282+github-actions[bot]@users.noreply.github.com" },
              message: "docs: earlier cumulative update",
              verification: { verified: true },
            },
            parents: [{ sha: previousTagSha }],
          },
          {
            sha: String(42).padStart(40, "0"),
            commit: {
              author: { email: "41898282+github-actions[bot]@users.noreply.github.com" },
              message: commitMessage,
              verification: { verified: true },
            },
            parents: [{ sha: previousTagSha }],
          },
        ],
      ]),
      GH_FILES_JSON: JSON.stringify([files]),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PREVIOUS_TAG_SHA: previousTagSha,
    },
  });
}

function auditFixture() {
  const packageJson = '{"name":"audit-fixture"}';
  const packageLock = '{"lockfileVersion":3}';
  const exceptionPolicy = '{"schemaVersion":1,"exceptions":[]}';
  const rawResponse = JSON.stringify({
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
  });
  const input = fixture({
    "agents/openclaw/mcporter-runtime/package.json": packageJson,
    "agents/openclaw/mcporter-runtime/package-lock.json": packageLock,
    "ci/npm-audit-exceptions.json": exceptionPolicy,
    "ci/reviewed-npm-audit.json": '{"npmVersion":"10.9.4"}',
  });
  const tool = fixture(
    Object.fromEntries(
      ["npm-audit-receipt.mts", "reviewed-npm-audit.mts"].map((name) => [
        `scripts/lib/${name}`,
        fs.readFileSync(path.join(repositoryRoot, "scripts/lib", name), "utf8"),
      ]),
    ),
  );
  const receipt = createAuditReceipt({
    acceptedAdvisoryIds: [],
    blockingAdvisoryIds: [],
    createdAt: new Date(),
    exceptionPolicySha256: sha256(exceptionPolicy),
    graphId: "mcporter-runtime",
    npmVersion: "10.9.4",
    packageJson,
    packageLock,
    rawResponse,
    registryOrigin: "https://registry.yarnpkg.com",
    severityThreshold: "high",
  });
  return { input, tool, rawResponse, receipt };
}

function runAuditReuse(
  audit: ReturnType<typeof auditFixture>,
  overrides: {
    artifact?: Record<string, unknown>;
    consumer?: Record<string, unknown>;
    env?: Record<string, string>;
    omitRaw?: boolean;
    cleanupFailure?: boolean;
    commands?: Record<string, string>;
  } = {},
) {
  const { input } = audit;
  const bin = path.join(input.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(input.root, "mcporter-runtime.receipt.json"),
    canonicalAuditReceipt(audit.receipt),
  );
  fs.writeFileSync(path.join(input.root, "mcporter-runtime.raw.json"), audit.rawResponse);
  const archive = path.join(input.root, "audit.zip");
  execFileSync(
    "zip",
    [
      "-q",
      archive,
      "mcporter-runtime.receipt.json",
      ...(overrides.omitRaw ? [] : ["mcporter-runtime.raw.json"]),
    ],
    { cwd: input.root },
  );
  const callLog = path.join(input.root, "gh-calls.txt");
  fs.writeFileSync(
    path.join(bin, "gh"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_CALL_LOG"
if [[ "$*" == *"/zip" ]]; then
  case "$GH_DOWNLOAD_FAILURE" in
    transport) exit 22 ;;
    termination) kill -TERM "$PPID"; exit 143 ;;
  esac
fi
case "$*" in
  "api repos/NVIDIA/NemoClaw/git/ref/heads/main --jq .object.sha") printf '%s\n' "$GH_MAIN_SHA" ;;
  "api repos/NVIDIA/NemoClaw/actions/runs/123/attempts/2") printf '%s\n' "$GH_CONSUMER" ;;
  "api repos/NVIDIA/NemoClaw/actions/artifacts/456") printf '%s\n' "$GH_ARTIFACT" ;;
  "api repos/NVIDIA/NemoClaw/actions/artifacts/456/zip") cat "$GH_ARCHIVE" ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  for (const [name, script] of Object.entries(overrides.commands ?? {})) {
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  }
  const result = spawnSync("bash", ["-c", auditReuseBlock], {
    cwd: input.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: input.evidenceDir,
      IMAGE_RUN_ID: "123",
      IMAGE_ATTEMPT: "2",
      IMAGE_SHA: input.candidate,
      IMAGE_EVENT: "push",
      IMAGE_SOURCE_DIR: input.root,
      AUDIT_TOOL_DIR: audit.tool.root,
      AUDIT_ARTIFACT_ID: "456",
      AUDIT_ARCHIVE_SHA256: sha256(fs.readFileSync(archive)),
      GH_MAIN_SHA: audit.tool.candidate,
      GH_CALL_LOG: callLog,
      GH_ARCHIVE: archive,
      GH_DOWNLOAD_FAILURE: "",
      GH_CONSUMER: JSON.stringify({
        id: 123,
        run_attempt: 2,
        head_sha: input.candidate,
        event: "push",
        path: ".github/workflows/base-image.yaml",
        repository: { full_name: "NVIDIA/NemoClaw" },
        ...overrides.consumer,
      }),
      GH_ARTIFACT: JSON.stringify({
        id: 456,
        name: "reviewed-npm-audit",
        expired: false,
        workflow_run: { id: 123, head_sha: input.candidate },
        ...overrides.artifact,
      }),
      ...overrides.env,
    },
  });
  const retained = fs
    .readdirSync(input.evidenceDir)
    .filter((name) => name.startsWith("nemoclaw-audit."));
  expect(retained).toHaveLength(overrides.cleanupFailure ? 1 : 0);
  for (const name of retained) expect(result.stderr).toContain(path.join(input.evidenceDir, name));
  expect(fs.existsSync(path.join(audit.tool.root, "scripts/lib/npm-audit-receipt.mts"))).toBe(true);
  expect(
    fs.existsSync(path.join(input.root, "agents/openclaw/mcporter-runtime/package.json")),
  ).toBe(true);
  return { result, calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "" };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("release candidate evidence commands", () => {
  it("verifies the consumer's audit receipt with its package and policy inputs", () => {
    const { result, calls } = runAuditReuse(auditFixture());
    expect(result.status, String(result.stderr)).toBe(0);
    expect(calls.trim().split("\n")).toEqual([
      "api repos/NVIDIA/NemoClaw/git/ref/heads/main --jq .object.sha",
      "api repos/NVIDIA/NemoClaw/actions/runs/123/attempts/2",
      "api repos/NVIDIA/NemoClaw/actions/artifacts/456",
      "api repos/NVIDIA/NemoClaw/actions/artifacts/456/zip",
    ]);
  });

  it.each([
    { consumer: { id: 124 } },
    { consumer: { run_attempt: 1 } },
    { consumer: { head_sha: "a".repeat(40) } },
    { consumer: { event: "workflow_dispatch" } },
    { consumer: { path: ".github/workflows/other.yaml" } },
    { artifact: { id: 457 } },
    { artifact: { expired: true } },
    { artifact: { workflow_run: { id: 124, head_sha: "a".repeat(40) } } },
    { env: { GH_MAIN_SHA: "a".repeat(40) } },
    { env: { IMAGE_SOURCE_DIR: "/nonexistent-audit-source" } },
  ])("stops before download when audit provenance differs: %j", (overrides) => {
    const { result, calls } = runAuditReuse(auditFixture(), overrides);
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain("/zip");
  });

  it.each([{ env: { AUDIT_ARCHIVE_SHA256: "a".repeat(64) } }, { omitRaw: true }])(
    "rejects an audit archive with invalid bytes or a missing entry: %j",
    (overrides) => {
      const { result } = runAuditReuse(auditFixture(), overrides);
      expect(result.status).not.toBe(0);
    },
  );

  it.each([
    { env: { GH_DOWNLOAD_FAILURE: "transport" }, status: 22 },
    { env: { GH_DOWNLOAD_FAILURE: "termination" }, status: 143 },
    { cleanupFailure: true, commands: { rm: "#!/usr/bin/env bash\nexit 79\n" }, status: 1 },
  ])(
    "preserves audit failure status and reports retained evidence: %j",
    ({ status, ...overrides }) => {
      const { result } = runAuditReuse(auditFixture(), overrides);
      expect(result.status, String(result.stderr)).toBe(status);
    },
  );

  it.each(["expiry", "packageLockSha256", "exceptionPolicySha256", "rawResponseSha256"] as const)(
    "rejects a receipt with mismatched %s through the existing verifier",
    (field) => {
      const audit = auditFixture();
      audit.receipt =
        field === "expiry"
          ? {
              ...audit.receipt,
              createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
              expiresAt: new Date(Date.now() - 12 * 60 * 60 * 1000 - 1).toISOString(),
            }
          : { ...audit.receipt, [field]: "a".repeat(64) };
      const { result } = runAuditReuse(audit);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(field === "expiry" ? "expired" : field);
    },
  );

  it("stops before download when the audit verifier has tracked edits", () => {
    const audit = auditFixture();
    fs.appendFileSync(
      path.join(audit.tool.root, "scripts/lib/npm-audit-receipt.mts"),
      "\n// changed\n",
    );
    const { result, calls } = runAuditReuse(audit);
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain("/zip");
  });

  it("reports both sides of a documentation rename for scope review", () => {
    const selection = selectionFixture();
    const result = runDocsPrSelection(
      selection,
      [docsCandidate(42, selection.ancestorMergeSha)],
      [{ filename: "docs/guide.mdx", previous_filename: "src/lib/example.ts", status: "renamed" }],
    );
    expect(result.status, String(result.stderr)).toBe(0);
    expect(
      fs
        .readFileSync(path.join(selection.input.evidenceDir, "docs-changed-paths.txt"), "utf8")
        .trim()
        .split("\n"),
    ).toEqual(["docs/guide.mdx", "src/lib/example.ts"]);
  });

  it.each([undefined, null, ""])(
    "stops when a renamed documentation file has no original path: %j",
    (previous_filename) => {
      const selection = selectionFixture();
      const result = runDocsPrSelection(
        selection,
        [docsCandidate(42, selection.ancestorMergeSha)],
        [{ filename: "docs/guide.mdx", previous_filename, status: "renamed" }],
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("renamed file lacks previous_filename");
    },
  );

  it("uses maintainer-visible coverage instead of an empty-patch receipt", () => {
    expect(evidence).toContain("1. Proceed with the candidate as shown.");
    expect(evidence).toContain("2. Create or update a docs PR for the uncovered range.");
    expect(evidence).toContain("- Maintainer decision: Proceed with the candidate as shown.");
    expect(evidence).not.toContain("approved-empty");
    expect(evidence).not.toContain("Final Documentation Recheck");
  });

  it("accepts the historical plan schema and records its release-entry exception", () => {
    const input = fixture({ "docs/changelog/2026-08-17.mdx": "# Releases\n" });
    const previous = input.candidate;
    git(input.root, "commit", "--allow-empty", "-m", "test: historical candidate");
    const candidate = git(input.root, "rev-parse", "HEAD");
    git(input.root, "commit", "--allow-empty", "-m", "test: current main");
    const originMain = git(input.root, "rev-parse", "HEAD");
    const reason = "Urgent QA qualification requires the preceding main commit.";
    const planPath = path.join(input.root, "plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        candidateCommit: candidate,
        candidateSelection: "historical",
        historicalCandidateException: reason,
        nextTag: "v1.2.3",
        originMainCommit: originMain,
        originMainHeadline: "main",
        previousTag: "v1.2.2",
        previousTagCommit: previous,
        previousTagObject: previous,
      }),
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        `${shellHelpers}\nPLAN_PATH="$PLAN_PATH"\n${planReadBlock}\ntrap - EXIT\n${releaseEntryBlock}`,
      ],
      {
        cwd: input.root,
        encoding: "utf8",
        env: { ...process.env, EVIDENCE_DIR: input.evidenceDir, PLAN_PATH: planPath },
      },
    );

    expect(result.status, String(result.stderr)).toBe(0);
    expect(fs.readFileSync(path.join(input.evidenceDir, "release-entry.md"), "utf8").trim()).toBe(
      `Release entry exception: ${reason}`,
    );
  });

  it("extracts only the exact release H2 section from a multi-entry changelog", () => {
    const input = fixture({
      "docs/changelog/2026-08-17.mdx": [
        "# Releases",
        "",
        "## v1.2.3",
        "",
        "- Current release.",
        "",
        "### Detail",
        "",
        "Still current.",
        "",
        "## v1.2.2",
        "",
        "Previous release.",
        "",
      ].join("\n"),
      "docs/changelog/2026-08-16.mdx": "# Releases\n\n## v1.2.1\n\nOlder release.\n",
      "docs/changelog/overview.mdx": "# Releases\n\n## v1.2.3\n\n- Not a dated entry.\n",
    });

    const result = runReleaseEntry(input);

    expect(result.status, String(result.stderr)).toBe(0);
    const entry = fs.readFileSync(path.join(input.evidenceDir, "release-entry.md"), "utf8");
    expect(entry.trim()).toBe(
      ["## v1.2.3", "", "- Current release.", "", "### Detail", "", "Still current."].join("\n"),
    );
    expect(entry).not.toContain("v1.2.2");
    expect(entry).not.toContain("Previous release");
  });

  it("stops when the exact release heading appears more than once", () => {
    const input = fixture({
      "docs/changelog/2026-08-17.mdx": "# Releases\n\n## v1.2.3\n\nOne.\n",
      "docs/changelog/2026-08-18.mdx": "# Releases\n\n## v1.2.3\n\nTwo.\n",
    });

    const result = runReleaseEntry(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected one release entry; found 2");
  });

  it("stops when the release entry has no detailed bullet", () => {
    const input = fixture({
      "docs/changelog/2026-08-17.mdx": "# Releases\n\n## v1.2.3\n",
    });

    const result = runReleaseEntry(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release-entry detail validation failed");
  });

  it("selects the first ancestor documentation PR and reads only that PR", () => {
    const selection = selectionFixture();
    const result = runDocsPrSelection(selection, [
      docsCandidate(41, selection.nonAncestorMergeSha),
      docsCandidate(42, selection.ancestorMergeSha),
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(
      fs.readFileSync(
        path.join(selection.input.evidenceDir, "selected-docs-pr-fields.tsv"),
        "utf8",
      ),
    ).toContain("42\thttps://github.com/NVIDIA/NemoClaw/pull/42");
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-coverage-sha"), "utf8").trim(),
    ).toBe(selection.previousTagSha);
    const calls = fs.readFileSync(path.join(selection.input.evidenceDir, "gh-calls.txt"), "utf8");
    expect(calls).toContain("/pulls/42/commits");
    expect(calls).toContain("/pulls/42/files");
    expect(calls).not.toContain("/pulls/41/");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(selection.input.evidenceDir, "docs-pr-checks.json"), "utf8"),
      ),
    ).toEqual([
      {
        __typename: "CheckRun",
        conclusion: "SUCCESS",
        name: "docs",
        status: "COMPLETED",
      },
    ]);
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-pr-final-sha"), "utf8").trim(),
    ).toBe(String(42).padStart(40, "0"));
  });

  it("records None and skips selected-PR reads when there are no candidates", () => {
    const selection = selectionFixture();
    const result = runDocsPrSelection(selection, []);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(
      fs
        .readFileSync(path.join(selection.input.evidenceDir, "selected-docs-pr-fields.tsv"), "utf8")
        .trim(),
    ).toBe("None\tNone\tNone\tNone\tNone");
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-coverage-sha"), "utf8").trim(),
    ).toBe(selection.previousTagSha);
    expect(fs.readFileSync(path.join(selection.input.evidenceDir, "gh-calls.txt"), "utf8")).toBe(
      "",
    );
  });

  it("rejects a non-ancestor merged documentation PR without reading it", () => {
    const selection = selectionFixture();
    const result = runDocsPrSelection(selection, [
      docsCandidate(41, selection.nonAncestorMergeSha),
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(
      fs
        .readFileSync(path.join(selection.input.evidenceDir, "selected-docs-pr-fields.tsv"), "utf8")
        .trim(),
    ).toBe("None\tNone\tNone\tNone\tNone");
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-coverage-sha"), "utf8").trim(),
    ).toBe(selection.previousTagSha);
    expect(fs.readFileSync(path.join(selection.input.evidenceDir, "gh-calls.txt"), "utf8")).toBe(
      "",
    );
  });
});
