// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const repo = input.repo ?? "NVIDIA/NemoClaw";
const failure = input.failure ?? "fail-fast";
const overwrite = input.overwrite === true;
if (typeof input.workdir !== "string" || !input.workdir.trim() || input.workdir.length > 4096)
  throw new Error("workdir must contain 1 to 4096 characters");
if (
  typeof repo !== "string" ||
  repo.length > 255 ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
)
  throw new Error("repo must be owner/name with at most 255 characters");
if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10)
  throw new Error("items must contain 1 to 10 recommendation carries");
const seen = new Set();
for (const item of input.items) {
  if (!Number.isSafeInteger(item.number) || item.number <= 0)
    throw new Error("each PR number must be a positive integer");
  if (!/^[0-9a-f]{40}$/.test(item.fromHeadSha) || !/^[0-9a-f]{40}$/.test(item.toHeadSha))
    throw new Error("fromHeadSha and toHeadSha must be lowercase 40-character SHAs");
  if (item.fromHeadSha === item.toHeadSha) throw new Error("fromHeadSha and toHeadSha must differ");
  if (seen.has(item.number)) throw new Error(`PR #${item.number} appears more than once`);
  seen.add(item.number);
}
const accessFailure =
  /authentication|authorization|forbidden|not authorized|HTTP 40[13]|resource not accessible|SSO/i;
const run = async (command, description, allowed = [0]) => {
  const result = await tools.bash({
    command,
    workdir: input.workdir,
    description,
    timeoutMs: 30000,
  });
  if (result.kind !== "foreground") throw new Error(`${description} did not finish`);
  const detail = `${result.stdout.text}\n${result.stderr.text}`.trim();
  if (!allowed.includes(result.exitCode)) {
    if (accessFailure.test(detail))
      throw new Error(`GitHub access failed; stop and restore repository access.\n${detail}`);
    throw new Error(`${description} failed.\n${detail}`);
  }
  return result.stdout.text;
};
if (
  typeof input.cacheRoot !== "string" ||
  !input.cacheRoot.startsWith("/") ||
  input.cacheRoot === "/" ||
  input.cacheRoot.length > 4096 ||
  /[\r\n\0]/.test(input.cacheRoot)
)
  throw new Error("cacheRoot must be a safe absolute path other than /");
const root = input.cacheRoot;
const readCache = async (path) => {
  const result = await tools.bash({
    command: "cat " + quote(path),
    workdir: input.workdir,
    description: "Read cached review recommendation",
    timeoutMs: 10000,
  });
  if (result.kind !== "foreground") throw new Error("Cache read did not finish");
  return { exists: result.exitCode === 0, text: result.stdout.text };
};
const blobAt = async (file, ref) => {
  const command = "gh api " + quote(`repos/${repo}/contents/${file}?ref=${ref}`) + " --jq .sha";
  const result = await tools.bash({
    command,
    workdir: input.workdir,
    description: "Read GitHub file blob identity",
    timeoutMs: 30000,
  });
  if (result.kind !== "foreground") throw new Error("GitHub file lookup did not finish");
  const detail = `${result.stdout.text}\n${result.stderr.text}`;
  if (result.exitCode === 0) return { exists: true, sha: result.stdout.text.trim() };
  if (/HTTP 404|Not Found/i.test(detail)) return { exists: false, sha: null };
  if (accessFailure.test(detail))
    throw new Error(
      `GitHub access failed while reading ${file} at ${ref}; stop and restore repository access.\n${detail.trim()}`,
    );
  throw new Error(`GitHub did not read ${file} at ${ref}.\n${detail.trim()}`);
};
const processItem = async (item) => {
  const prText = await run(
    "gh pr view " +
      item.number +
      " --repo " +
      quote(repo) +
      " --json number,title,url,state,isDraft,headRefOid,files",
    "Read pull request for cache carry",
  );
  const pr = JSON.parse(prText);
  if (pr.state !== "OPEN" || pr.isDraft)
    throw new Error(`PR #${item.number} must be open and non-draft`);
  if (pr.headRefOid !== item.toHeadSha)
    throw new Error(
      `PR #${item.number} commit changed: expected ${item.toHeadSha}, found ${pr.headRefOid}`,
    );
  const sourcePath = `${root}/${item.number}/${item.fromHeadSha}/recommendation.json`;
  const destinationPath = `${root}/${item.number}/${item.toHeadSha}/recommendation.json`;
  const sourceResult = await readCache(sourcePath);
  if (!sourceResult.exists)
    throw new Error(
      `No cached recommendation exists for PR #${item.number} at ${item.fromHeadSha}`,
    );
  const source = JSON.parse(sourceResult.text);
  if (
    source.reviewedSha !== item.fromHeadSha ||
    source.recommendation?.expectedCommit !== item.fromHeadSha ||
    source.recommendation?.result !== "APPROVE"
  )
    throw new Error(`PR #${item.number} source cache is not an exact APPROVE recommendation`);
  const files = (pr.files ?? []).map((file) => String(file.path ?? ""));
  const comparisons = [];
  for (const file of files) {
    const [from, to] = await Promise.all([
      blobAt(file, item.fromHeadSha),
      blobAt(file, item.toHeadSha),
    ]);
    comparisons.push({ file, unchanged: from.exists === to.exists && from.sha === to.sha });
  }
  const changedFiles = comparisons.filter((entry) => !entry.unchanged).map((entry) => entry.file);
  if (changedFiles.length)
    return {
      number: item.number,
      url: pr.url,
      status: "REVIEW_REQUIRED",
      fromHeadSha: item.fromHeadSha,
      toHeadSha: item.toHeadSha,
      changedFiles,
    };
  const existing = await readCache(destinationPath);
  if (existing.exists && !overwrite)
    return {
      number: item.number,
      url: pr.url,
      status: "ALREADY_CARRIED",
      fromHeadSha: item.fromHeadSha,
      toHeadSha: item.toHeadSha,
      fileCount: files.length,
      destinationPath,
    };
  const carried = JSON.parse(JSON.stringify(source));
  carried.reviewedSha = item.toHeadSha;
  carried.savedAt = new Date().toISOString();
  carried.recommendation.expectedCommit = item.toHeadSha;
  carried.recommendation.observedCommit = item.toHeadSha;
  carried.recommendation.validation = [
    ...(carried.recommendation.validation ?? []),
    `Automated parent verification confirmed identical Git blob identities for all ${files.length} PR files between ${item.fromHeadSha.slice(0, 12)} and ${item.toHeadSha.slice(0, 12)}.`,
  ];
  if (input.apply) {
    const script =
      "const fs=require('fs'),p=require('path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2])";
    await run(
      "node -e " +
        quote(script) +
        " " +
        quote(destinationPath) +
        " " +
        quote(JSON.stringify(carried)),
      "Write carried review recommendation",
    );
  }
  return {
    number: item.number,
    url: pr.url,
    status: input.apply ? "CARRIED" : "WOULD_CARRY",
    fromHeadSha: item.fromHeadSha,
    toHeadSha: item.toHeadSha,
    fileCount: files.length,
    destinationPath,
  };
};
const results = [];
for (const item of input.items) {
  try {
    results.push(await processItem(item));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (accessFailure.test(message) || /GitHub access failed/i.test(message)) throw error;
    if (failure === "fail-fast") throw error;
    results.push({
      number: item.number,
      status: "NOT_CARRIED",
      fromHeadSha: item.fromHeadSha,
      toHeadSha: item.toHeadSha,
      error: message,
    });
  }
}
return {
  repo,
  apply: input.apply,
  failure,
  mutated: input.apply && results.some((entry) => entry.status === "CARRIED"),
  carried: results.filter((entry) =>
    ["CARRIED", "WOULD_CARRY", "ALREADY_CARRIED"].includes(entry.status),
  ).length,
  notCarried: results.filter((entry) => entry.status === "NOT_CARRIED").length,
  results,
};
