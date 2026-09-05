// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { quantile, round } from "./statistics.mts";
import { projectDiagnostic, runGithub, runShell } from "./runtime.mts";

export function reportCleanupFailure(analysisError: unknown, cleanupError: Error): void {
  if (analysisError === undefined) throw cleanupError;
}

export async function analyzeRecentCliTimings(input: {
  workdir: string;
  repo?: string;
  limit?: number;
  top?: number;
  minSampleRatio?: number;
  artifactName?: string;
}): Promise<{
  repo: string;
  artifactName: string;
  reportsRequested: number;
  reportsFound: number;
  reportsAnalyzed: number;
  downloadFailures: { runId: number; detail: string }[];
  minSamples: number;
  runs: {
    runId: number;
    createdAt: string;
    headSha: string;
    totalTests: number;
    testFiles: number;
  }[];
  slowTests: {
    file: string;
    name: string;
    samples: number;
    medianMs: number;
    p90Ms: number;
    minMs: number;
    maxMs: number;
  }[];
  slowFiles: {
    file: string;
    samples: number;
    medianWallMs: number;
    p90WallMs: number;
    maxWallMs: number;
  }[];
}> {
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
  const quote = (value: unknown) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const project = async (
    value: unknown,
    maxCharacters: number,
    clipMode: "head" | "tail" = "tail",
  ) => projectDiagnostic(String(value), maxCharacters, clipMode);
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
  const run = async (command: string, timeoutMs = 120000) => {
    const result = await runShell(command, input.workdir, timeoutMs);
    const detail = (result.stderr + "\n" + result.stdout).toLowerCase();
    if (result.exitCode !== 0 && accessFailures.some((value) => detail.includes(value)))
      throw new Error(
        "GitHub access failed; correct authentication or authorization before retrying.\n" +
          (await project(result.stderr, 1500)),
      );
    return result;
  };
  const candidateLimit = Math.min(100, limit * 10);
  const trustedRunsResult = await runGithub(
    [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "main.yaml",
      "--branch",
      "main",
      "--event",
      "push",
      "--status",
      "success",
      "--limit",
      String(candidateLimit),
      "--json",
      "databaseId,headSha,createdAt,conclusion,event,headBranch,workflowName",
      "--jq",
      '[.[]|select(.workflowName=="CI / Main Branch" and .event=="push" and .headBranch=="main" and .conclusion=="success")|{runId:.databaseId,headSha,createdAt}]',
    ],
    input.workdir,
    60000,
  );
  let trustedRunData;
  try {
    trustedRunData = JSON.parse(trustedRunsResult.stdout);
  } catch {
    throw new Error("Could not parse bounded trusted main run listing");
  }
  const trustedRuns = new Map();
  for (const run of Array.isArray(trustedRunData) ? trustedRunData : []) {
    const runId = Number(run.runId);
    const headSha = String(run.headSha ?? "");
    if (Number.isSafeInteger(runId) && runId > 0 && /^[0-9a-f]{40}$/i.test(headSha))
      trustedRuns.set(runId, { headSha, createdAt: String(run.createdAt ?? "") });
  }
  const endpoint = `repos/${repo}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`;
  const listed = await runGithub(
    [
      "api",
      endpoint,
      "--jq",
      "{artifacts:[.artifacts[]|{id,createdAt:.created_at,expired,size:.size_in_bytes,runId:.workflow_run.id,headSha:.workflow_run.head_sha}]}",
    ],
    input.workdir,
    60000,
  );
  let artifactData;
  try {
    artifactData = JSON.parse(listed.stdout);
  } catch {
    throw new Error("Could not parse bounded artifact listing");
  }
  const seen = new Set();
  const artifacts = [];
  const failures = [];
  for (const artifact of artifactData.artifacts ?? []) {
    const runId = Number(artifact.runId ?? 0);
    const trusted = trustedRuns.get(runId);
    if (
      !trusted ||
      artifact.expired ||
      seen.has(runId) ||
      String(artifact.headSha ?? "") !== trusted.headSha
    )
      continue;
    seen.add(runId);
    const size = artifact.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 25000000) {
      failures.push({
        runId,
        detail: "Artifact has an invalid compressed size or exceeds the 25,000,000-byte limit",
      });
      continue;
    }
    const artifactId = Number(artifact.id);
    if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
      failures.push({ runId, detail: "Artifact has an invalid artifact ID" });
      continue;
    }
    artifacts.push({
      artifactId,
      runId,
      createdAt: trusted.createdAt,
      headSha: trusted.headSha,
      size,
    });
    if (artifacts.length >= limit) break;
  }
  if (artifacts.length < 2)
    throw new Error(`Found ${artifacts.length} eligible retained reports; at least 2 are required`);
  const temporary = await run(
    'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-cli-timings.XXXXXXXXXX"',
    30000,
  );
  if (temporary.exitCode !== 0) throw new Error("Could not create private temporary directory");
  const root = temporary.stdout.trim();
  if (!root || !root.startsWith("/") || /[\r\n\0]/u.test(root))
    throw new Error("Could not create private temporary directory");
  const tests = new Map<string, number[]>();
  const files = new Map<string, number[]>();
  const runs = [];
  let reportsAnalyzed = 0;
  const maximumSuites = 5_000;
  const maximumAssertions = 100_000;
  const maximumLabels = 2_000;
  let analysisError: unknown;
  try {
    for (const artifact of artifacts) {
      const archive = root + "/" + artifact.runId + ".zip";
      const downloaded = await run(
        `output=${quote(archive)}; metadata=${quote(archive + ".stream")}; umask 077; set +e; set -o pipefail; gh api ${quote(`repos/${repo}/actions/artifacts/${artifact.artifactId}/zip`)} | { : > "$output" || exit 1; dd bs=65536 count=381 iflag=fullblock status=none >> "$output"; full_status=$?; dd bs=1 count=30784 iflag=fullblock status=none >> "$output"; remainder_status=$?; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); bytes=$(stat -c %s -- "$output") || exit 1; state=ok; if [ -n "$extra" ]; then state=limit; elif [ "$full_status" -ne 0 ] || [ "$remainder_status" -ne 0 ]; then state=reader; fi; printf '%s %s\n' "$state" "$bytes" > "$metadata"; }; statuses=("\${PIPESTATUS[@]}"); read -r state bytes < "$metadata" || state=reader; rm -f -- "$metadata"; printf '%s %s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$state" "$bytes"`,
      );
      const [downloadStatus, downloadReaderStatus, downloadState, downloadBytesText] =
        downloaded.stdout.trim().split(/\s+/, 4);
      const downloadBytes = Number(downloadBytesText);
      if (
        downloadState === "limit" ||
        downloaded.exitCode !== 0 ||
        downloadStatus !== "0" ||
        downloadReaderStatus !== "0" ||
        downloadState !== "ok" ||
        !Number.isSafeInteger(downloadBytes) ||
        downloadBytes !== artifact.size
      ) {
        failures.push({
          runId: artifact.runId,
          detail:
            downloadState === "limit"
              ? "Artifact compressed stream exceeds the 25,000,000-byte limit"
              : await project(downloaded.stderr || downloaded.stdout, 1000),
        });
        continue;
      }
      const checked = await run(
        `root=${quote(root)}; archive=${quote(archive)}; expected=${quote(artifact.size)}; measured=$(stat -c %s -- "$archive") || { printf 'malformed\n'; exit 0; }; if [ "$measured" -gt 25000000 ] || [ "$measured" -ne "$expected" ]; then printf 'compressed-size\n'; exit 0; fi; summary=$(LC_ALL=C zipinfo -t "$archive" 2>/dev/null) || { printf 'malformed\n'; exit 0; }; if [[ "$summary" == *$'\n'* ]] || [[ ! "$summary" =~ ^([0-9]+)[[:space:]]files?,[[:space:]]([0-9]+)[[:space:]]bytes[[:space:]]uncompressed, ]]; then printf 'malformed\n'; exit 0; fi; entries=\${BASH_REMATCH[1]}; expanded=\${BASH_REMATCH[2]}; if [ "$entries" -gt 100 ]; then printf 'entries\n'; exit 0; fi; if [ "$expanded" -gt 100000000 ]; then printf 'expanded\n'; exit 0; fi; listing=$(umask 077; mktemp "$root/zip-listing.XXXXXXXXXX") || { printf 'malformed\n'; exit 0; }; names=$(umask 077; mktemp "$root/zip-names.XXXXXXXXXX") || { rm -f -- "$listing"; printf 'malformed\n'; exit 0; }; trap 'rm -f -- "$listing" "$names"' EXIT; LC_ALL=C zipinfo -l "$archive" > "$listing" 2>/dev/null || { printf 'malformed\n'; exit 0; }; LC_ALL=C zipinfo -1 "$archive" > "$names" 2>/dev/null || { printf 'malformed\n'; exit 0; }; listing_bytes=$(wc -c < "$listing") || { printf 'malformed\n'; exit 0; }; if [ "$listing_bytes" -gt 7000000 ]; then printf 'listing\n'; exit 0; fi; state=$(awk -v expected="$entries" 'NR==FNR { exact[FNR]=$0; next } BEGIN { count=0; state="ok" } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { count++; mode=substr($0,1,1); size=$4; line=$0; for (i=1;i<=9;i++) sub(/^[^[:space:]]+[[:space:]]+/, "", line); name=exact[count]; if (line != name || name ~ /^[[:space:]]/ || name ~ /[[:space:]]$/) state="path"; if (mode != "-" && mode != "d") state="type"; if (size !~ /^[0-9]+$/) state="parser"; if (name == "" || (name ~ /^-/ || substr(name,1,1) == "/") || name ~ /[\\\\]/ || name ~ /[[:cntrl:]]/ || name ~ /[*?[[]/) state="path"; parts=split(name, component, "/"); last=parts; if (mode == "d" && component[parts] == "") last--; else if (component[parts] == "") state="path"; for (i=1;i<=last;i++) if (component[i] == "" || component[i] == "." || component[i] == "..") state="path"; output=name; if (substr(output,length(output),1) == "/") output=substr(output,1,length(output)-1); if (output == "" || seen[output]++) state="duplicate"; next } /^[0-9]+ files?, [0-9]+ bytes uncompressed, / { summaries++; next } { state="parser" } END { if (count != expected || summaries != 1) state="parser"; print state }' "$names" "$listing"); if [ "$state" != ok ]; then printf '%s\n' "$state"; exit 0; fi; unzip -tqq "$archive" >/dev/null 2>&1 || { printf 'malformed\n'; exit 0; }; selected=$(umask 077; mktemp "$root/selected.XXXXXXXXXX") || { printf 'malformed\n'; exit 0; }; trap 'rm -f -- "$listing" "$names" "$selected"' EXIT; count=$(awk -v selected="$selected" 'NR==FNR { exact[FNR]=$0; next } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { entry++; name=exact[entry]; if (substr($0, 1, 1) == "-") { parts=split(name, component, "/"); if (component[parts] == "vitest-results.json") { printf "%s\t%s%c", $4, name, 0 > selected; count++ } } } END { print count+0 }' "$names" "$listing") || { printf 'parser\n'; exit 0; }; encoded=$(base64 -w0 < "$selected") || { printf 'parser\n'; exit 0; }; printf 'ok %s %s\n' "$count" "$encoded"`,
        30000,
      );
      const parts = checked.stdout.trim().split(/\s+/, 3);
      const archiveState = parts[0];
      if (checked.exitCode !== 0 || archiveState !== "ok") {
        const details: Record<string, string> = {
          "compressed-size": "Artifact compressed size is invalid or differs from its metadata",
          entries: "Artifact contains more than 100 entries",
          expanded: "Artifact declares more than 100,000,000 expanded bytes",
          type: "Artifact contains a symlink or another unsupported entry type",
          path: "Artifact contains an unsafe, ambiguous, or option-like path",
          duplicate: "Artifact contains duplicate output paths",
          listing: "Artifact entry listing exceeds the inspection limit",
          parser: "Artifact entry listing is ambiguous",
          malformed: "Artifact ZIP is malformed",
        };
        const unknownDetail = checked.stderr || checked.stdout;
        failures.push({
          runId: artifact.runId,
          detail:
            details[archiveState] ??
            (await project(
              unknownDetail
                ? `Could not inspect artifact ZIP: ${unknownDetail}`
                : `Could not inspect artifact ZIP (exit ${checked.exitCode})`,
              1_000,
            )),
        });
        continue;
      }
      const count = Number(parts[1]);
      const selections = Buffer.from(parts[2] ?? "", "base64")
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      if (count !== 1 || selections.length !== 1) {
        failures.push({
          runId: artifact.runId,
          detail: `Expected one vitest-results.json file, found ${count}`,
        });
        continue;
      }
      const separator = selections[0].indexOf("\t");
      const declaredBytes = Number(selections[0].slice(0, separator));
      const entry = selections[0].slice(separator + 1);
      if (separator < 1 || !Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || !entry) {
        failures.push({ runId: artifact.runId, detail: "Artifact entry listing is ambiguous" });
        continue;
      }
      const reportPath = root + "/report-" + artifact.runId;
      const streamed = await run(
        `archive=${quote(archive)}; entry=${quote(entry)}; output=${quote(reportPath)}; metadata=${quote(reportPath + ".stream")}; umask 077; set +e; set -o pipefail; unzip -p "$archive" "$entry" | { : > "$output" || exit 1; dd bs=65536 count=1525 iflag=fullblock status=none >> "$output"; full_status=$?; dd bs=1 count=57600 iflag=fullblock status=none >> "$output"; remainder_status=$?; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); bytes=$(stat -c %s -- "$output") || exit 1; state=ok; if [ -n "$extra" ]; then state=limit; elif [ "$full_status" -ne 0 ] || [ "$remainder_status" -ne 0 ]; then state=reader; fi; printf '%s %s\n' "$state" "$bytes" > "$metadata"; }; statuses=("\${PIPESTATUS[@]}"); read -r state bytes < "$metadata" || state=reader; rm -f -- "$metadata"; printf '%s %s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$state" "$bytes"`,
        30000,
      );
      const [unzipStatus, readerStatus, streamState, byteText] = streamed.stdout
        .trim()
        .split(/\s+/, 4);
      const reportBytes = Number(byteText);
      if (
        streamState === "limit" ||
        streamed.exitCode !== 0 ||
        unzipStatus !== "0" ||
        readerStatus !== "0" ||
        streamState !== "ok" ||
        !Number.isSafeInteger(reportBytes) ||
        reportBytes !== declaredBytes ||
        reportBytes > 100000000
      ) {
        failures.push({
          runId: artifact.runId,
          detail: "Could not stream bounded vitest-results.json content",
        });
        continue;
      }
      try {
        const metadata = await stat(reportPath);
        if (!metadata.isFile() || metadata.size !== reportBytes || metadata.size > 100_000_000)
          throw new Error("bounded report size");
        const report = await readFile(reportPath, "utf8");
        if (Buffer.byteLength(report) !== metadata.size)
          throw new Error("report changed while read");
        const data = JSON.parse(report);
        const suites = data?.testResults;
        const totalTests = data?.numTotalTests;
        if (
          !Array.isArray(suites) ||
          suites.length > maximumSuites ||
          !Number.isSafeInteger(totalTests) ||
          totalTests < 0 ||
          totalTests > maximumAssertions
        )
          throw new Error("report structure exceeds limits");
        let assertionCount = 0;
        const runFiles = new Set<string>();
        const runTests = new Set<string>();
        const repoName = repo.split("/")[1];
        const marker = "/" + repoName + "/" + repoName + "/";
        for (const suite of suites) {
          if (!suite || typeof suite !== "object" || !Array.isArray(suite.assertionResults))
            throw new Error("invalid suite structure");
          assertionCount += suite.assertionResults.length;
          if (assertionCount > maximumAssertions) throw new Error("too many assertions");
          const rawFile = String(suite.name ?? "");
          const markerIndex = rawFile.lastIndexOf(marker);
          const cleanedFile =
            markerIndex >= 0 ? rawFile.slice(markerIndex + marker.length) : rawFile;
          if (cleanedFile.length > maximumLabels) throw new Error("file label exceeds limit");
          const file = await project(cleanedFile, maximumLabels, "head");
          const start = Number(suite.startTime);
          const end = Number(suite.endTime);
          if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end >= start &&
            !runFiles.has(file)
          ) {
            runFiles.add(file);
            const values = files.get(file) ?? [];
            values.push(end - start);
            files.set(file, values);
          }
          for (const test of suite.assertionResults) {
            if (!test || typeof test !== "object") throw new Error("invalid assertion structure");
            const duration = test.duration;
            if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
              continue;
            const ancestors = test.ancestorTitles;
            if (ancestors !== undefined && !Array.isArray(ancestors))
              throw new Error("invalid assertion ancestors");
            const name = String(
              test.fullName || [...(ancestors ?? []), test.title ?? ""].join(" "),
            );
            if (name.length > maximumLabels) throw new Error("test label exceeds limit");
            const key = JSON.stringify([file, name]);
            if (runTests.has(key)) continue;
            runTests.add(key);
            if (!tests.has(key) && tests.size >= maximumAssertions)
              throw new Error("too many distinct tests");
            const values = tests.get(key) ?? [];
            values.push(duration);
            tests.set(key, values);
          }
        }
        runs.push({
          runId: artifact.runId,
          createdAt: artifact.createdAt,
          headSha: artifact.headSha,
          totalTests,
          testFiles: suites.length,
        });
        reportsAnalyzed += 1;
      } catch {
        failures.push({
          runId: artifact.runId,
          detail: "Could not parse bounded vitest-results.json structure",
        });
      } finally {
        await run("rm -f -- " + quote(reportPath), 30_000);
      }
    }
    if (reportsAnalyzed < 2) {
      const evidence = failures
        .slice(0, 10)
        .map(({ runId, detail }) => `run ${runId}: ${detail}`)
        .join("; ");
      throw new Error(
        `Downloaded ${reportsAnalyzed} usable reports; at least 2 are required${evidence ? `: ${evidence}` : ""}`,
      );
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const minimum = Math.max(2, Math.ceil(reportsAnalyzed * ratio));
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
      reportsAnalyzed,
      downloadFailures: failures.slice(0, 10),
      minSamples: minimum,
      runs,
      slowTests,
      slowFiles,
    };
  } catch (error) {
    analysisError = error;
    throw error;
  } finally {
    const cleanup = await run("rm -rf -- " + quote(root), 30_000);
    if (cleanup.exitCode !== 0)
      reportCleanupFailure(
        analysisError,
        new Error(
          "Could not remove private temporary directory: " +
            (await project(cleanup.stderr || cleanup.stdout, 1_000)),
        ),
      );
  }
}

function parseCli(): Parameters<typeof analyzeRecentCliTimings>[0] {
  const { values } = parseArgs({
    options: {
      workdir: { type: "string" },
      repo: { type: "string" },
      limit: { type: "string" },
      top: { type: "string" },
      "min-sample-ratio": { type: "string" },
      "artifact-name": { type: "string" },
    },
    strict: true,
  });
  return {
    workdir: values.workdir ?? process.cwd(),
    repo: values.repo,
    limit: values.limit === undefined ? undefined : Number(values.limit),
    top: values.top === undefined ? undefined : Number(values.top),
    minSampleRatio:
      values["min-sample-ratio"] === undefined ? undefined : Number(values["min-sample-ratio"]),
    artifactName: values["artifact-name"],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  analyzeRecentCliTimings(parseCli())
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
