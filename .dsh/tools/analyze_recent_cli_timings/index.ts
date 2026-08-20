// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const artifactName = input.artifactName ?? "cli-vitest-results";
const limit = input.limit ?? 10;
const top = input.top ?? 15;
const ratio = input.minSampleRatio ?? 0.7;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^[A-Za-z0-9_.-]{1,100}$/.test(artifactName))
  throw new Error("artifactName contains unsupported characters");
if (!Number.isInteger(limit) || limit < 2 || limit > 20)
  throw new Error("limit must be an integer from 2 through 20");
if (!Number.isInteger(top) || top < 1 || top > 50)
  throw new Error("top must be an integer from 1 through 50");
if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 1)
  throw new Error("minSampleRatio must be from 0.5 through 1");
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const redact = (value) =>
  String(value)
    .replace(/(authorization:?)\s*\S+/gi, "$1 [REDACTED]")
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)=)\S+/g, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "/[HOME]");
const accessFailures = [
  "authentication",
  "authorization",
  "forbidden",
  "not authorized",
  "http 401",
  "http 403",
  "resource not accessible",
  "sso",
];
const run = async (command, timeoutMs = 120000) => {
  const result = await tools.bash({
    command,
    workdir: input.workdir,
    description: "Read bounded CLI timing artifacts",
    timeoutMs,
  });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  const detail = (result.stderr.text + "\n" + result.stdout.text).toLowerCase();
  if (result.exitCode !== 0 && accessFailures.some((value) => detail.includes(value)))
    throw new Error(
      "GitHub access failed; correct authentication or authorization before retrying.\n" +
        redact(result.stderr.text).slice(-1500),
    );
  return result;
};
const perPage = Math.min(100, Math.max(30, limit * 3));
const endpoint = `repos/${repo}/actions/artifacts?name=${artifactName}&per_page=${perPage}`;
const listed = await run(
  "gh api " +
    quote(endpoint) +
    " --jq " +
    quote(
      "{artifacts:[.artifacts[]|{id,createdAt:.created_at,expired,size:.size_in_bytes,runId:.workflow_run.id,headSha:.workflow_run.head_sha}]}",
    ),
  60000,
);
if (listed.exitCode !== 0)
  throw new Error("Could not list artifacts.\n" + redact(listed.stderr.text).slice(-1500));
let artifactData;
try {
  artifactData = JSON.parse(listed.stdout.text);
} catch {
  throw new Error("Could not parse bounded artifact listing");
}
const seen = new Set();
const artifacts = [];
for (const artifact of artifactData.artifacts ?? []) {
  const runId = Number(artifact.runId ?? 0);
  if (!runId || artifact.expired || seen.has(runId)) continue;
  seen.add(runId);
  artifacts.push({
    artifactId: Number(artifact.id),
    runId,
    createdAt: String(artifact.createdAt),
    headSha: String(artifact.headSha),
    size: Number(artifact.size),
  });
  if (artifacts.length >= limit) break;
}
if (artifacts.length < 2)
  throw new Error(`Found ${artifacts.length} retained reports; at least 2 are required`);
const temporary = await run("mktemp -d " + quote("nemoclaw-cli-timings.XXXXXXXXXX"), 30000);
if (temporary.exitCode !== 0) throw new Error("Could not create private temporary directory");
const root = temporary.stdout.text.trim();
if (!root) throw new Error("Could not create private temporary directory");
const reports = [];
const failures = [];
try {
  for (const artifact of artifacts) {
    const directory = root + "/" + artifact.runId;
    const downloaded = await run(
      "mkdir -p " +
        quote(directory) +
        " && gh run download " +
        quote(artifact.runId) +
        " --repo " +
        quote(repo) +
        " --name " +
        quote(artifactName) +
        " --dir " +
        quote(directory),
    );
    if (downloaded.exitCode !== 0) {
      failures.push({
        runId: artifact.runId,
        detail: redact(downloaded.stderr.text || downloaded.stdout.text).slice(-1000),
      });
      continue;
    }
    const matches = await tools.glob({ pattern: "**/vitest-results.json", path: directory });
    if (matches.paths.length !== 1) {
      failures.push({
        runId: artifact.runId,
        detail: `Expected one vitest-results.json file, found ${matches.paths.length}`,
      });
      continue;
    }
    const report = await tools.read({ file_path: matches.paths[0], limit: 2000 });
    try {
      reports.push({
        artifact,
        data: JSON.parse(report.lines.map((line) => line.text).join("\n")),
      });
    } catch {
      failures.push({ runId: artifact.runId, detail: "Could not parse vitest-results.json" });
    }
  }
  if (reports.length < 2)
    throw new Error(`Downloaded ${reports.length} usable reports; at least 2 are required`);
  reports.sort((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt));
  const tests = new Map();
  const files = new Map();
  const runs = [];
  const repoName = repo.split("/")[1];
  const marker = "/" + repoName + "/" + repoName + "/";
  const clean = (value) => {
    const index = value.lastIndexOf(marker);
    return index >= 0 ? value.slice(index + marker.length) : redact(value);
  };
  for (const { artifact, data } of reports) {
    const suites = data.testResults ?? [];
    runs.push({
      runId: artifact.runId,
      createdAt: artifact.createdAt,
      headSha: artifact.headSha,
      totalTests: Number(data.numTotalTests || 0),
      testFiles: suites.length,
    });
    for (const suite of suites) {
      const file = clean(String(suite.name || ""));
      const wall = Math.max(0, Number(suite.endTime || 0) - Number(suite.startTime || 0));
      files.set(file, [...(files.get(file) ?? []), wall]);
      for (const test of suite.assertionResults ?? []) {
        const duration = test.duration;
        if (typeof duration !== "number" || !Number.isFinite(duration)) continue;
        const name = String(
          test.fullName || [...(test.ancestorTitles ?? []), test.title ?? ""].join(" "),
        );
        const key = JSON.stringify([file, name]);
        tests.set(key, [...(tests.get(key) ?? []), duration]);
      }
    }
  }
  const quantile = (values, q) => {
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return low === high
      ? sorted[low]
      : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  const round = (value) => Math.round(value * 10) / 10;
  const minimum = Math.max(2, Math.ceil(reports.length * ratio));
  const slowTests = [...tests.entries()]
    .filter(([, values]) => values.length >= minimum)
    .map(([key, values]) => {
      const [file, name] = JSON.parse(key);
      return {
        file,
        name,
        samples: values.length,
        medianMs: round(quantile(values, 0.5)),
        p90Ms: round(quantile(values, 0.9)),
        minMs: round(Math.min(...values)),
        maxMs: round(Math.max(...values)),
      };
    })
    .sort((a, b) => b.medianMs - a.medianMs)
    .slice(0, top);
  const slowFiles = [...files.entries()]
    .filter(([, values]) => values.length >= minimum)
    .map(([file, values]) => ({
      file,
      samples: values.length,
      medianWallMs: round(quantile(values, 0.5)),
      p90WallMs: round(quantile(values, 0.9)),
      maxWallMs: round(Math.max(...values)),
    }))
    .sort((a, b) => b.medianWallMs - a.medianWallMs)
    .slice(0, top);
  return {
    repo,
    artifactName,
    reportsRequested: limit,
    reportsFound: artifacts.length,
    reportsAnalyzed: reports.length,
    downloadFailures: failures.slice(0, 10),
    minSamples: minimum,
    runs,
    slowTests,
    slowFiles,
  };
} finally {
  await run("rm -rf -- " + quote(root), 30000);
}
