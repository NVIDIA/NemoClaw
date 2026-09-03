// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { medianConfidenceInterval, quantile, round } from "./statistics.mts";
import { runGithub } from "./runtime.mts";

export async function analyzeBaseImagePublicationTimings(input: {
  workdir: string;
  repo?: string;
  e2eLimit?: number;
  baseLimit?: number;
  maxPerStratum?: number;
}): Promise<{
  measuredAt: string;
  population: {
    completedE2eRuns: number;
    range: (string | null)[];
    classified: { "same-commit-publication": number; "reuse-prior-publication": number };
    method: string;
  };
  sameCommitPublication: {
    selectedRuns: number;
    successfulJobs: number;
    atLeast30SuccessfulJobs: boolean;
    outcomes: { name: string; count: number }[];
    jobExecution: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    verifier: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    workflowCreationToCompletion: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    runnerQueue: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    boundaryToMatrixStart: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
  };
  reusePriorPublication: {
    selectedRuns: number;
    successfulJobs: number;
    atLeast30SuccessfulJobs: boolean;
    outcomes: { name: string; count: number }[];
    jobExecution: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    verifier: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    workflowCreationToCompletion: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    runnerQueue: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    boundaryToMatrixStart: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
  };
  combined: {
    selectedRuns: number;
    successfulJobs: number;
    atLeast30SuccessfulJobs: boolean;
    outcomes: { name: string; count: number }[];
    jobExecution: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    verifier: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    workflowCreationToCompletion: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    runnerQueue: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
    boundaryToMatrixStart: {
      n: number;
      minSeconds: number;
      medianSeconds: number;
      median95CiSeconds: number[];
      meanSeconds: number;
      mean95CiSeconds: number[];
      p90Seconds: number;
      p95Seconds: number;
      maxSeconds: number;
    } | null;
  };
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  const e2eLimit = input.e2eLimit ?? 300;
  const baseLimit = input.baseLimit ?? 500;
  const maxPerStratum = input.maxPerStratum ?? 150;
  if (!Number.isFinite(e2eLimit) || !Number.isInteger(e2eLimit) || e2eLimit < 30 || e2eLimit > 500)
    throw new Error("e2eLimit must be a finite integer from 30 through 500");
  if (
    !Number.isFinite(baseLimit) ||
    !Number.isInteger(baseLimit) ||
    baseLimit < e2eLimit ||
    baseLimit > 500
  )
    throw new Error("baseLimit must be a finite integer from e2eLimit through 500");
  if (
    !Number.isFinite(maxPerStratum) ||
    !Number.isInteger(maxPerStratum) ||
    maxPerStratum < 30 ||
    maxPerStratum > 200
  )
    throw new Error("maxPerStratum must be a finite integer from 30 through 200");
  const gh = async (args, timeoutMs = 60000) => {
    const result = await runGithub(args, input.workdir, timeoutMs);
    return result.stdout;
  };
  const parse = (text, label) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub ${label} data exceeded the bounded response; reduce the run limit`);
    }
  };
  const list = async (workflow, limit, fields, jq) =>
    parse(
      await gh([
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        workflow,
        "--branch",
        "main",
        "--event",
        "push",
        "--limit",
        String(limit),
        "--json",
        fields,
        "--jq",
        jq,
      ]),
      workflow + " run",
    );
  const e2e = await list(
    "e2e.yaml",
    e2eLimit,
    "databaseId,headSha,createdAt,status",
    '[.[]|select(.status=="completed")|{id:.databaseId,sha:.headSha,createdAt}]',
  );
  const base = new Set(await list("base-image.yaml", baseLimit, "headSha", "[.[].headSha]"));
  const groups = {
    "same-commit-publication": e2e.filter((run) => base.has(run.sha)),
    "reuse-prior-publication": e2e.filter((run) => !base.has(run.sha)),
  };
  const select = (values, count) => {
    if (values.length <= count) return values;
    return Array.from(
      { length: count },
      (_, index) => values[Math.round((index * (values.length - 1)) / (count - 1))],
    );
  };
  const selected = Object.entries(groups).flatMap(([stratum, runs]) =>
    select(runs, maxPerStratum).map((run) => ({ ...run, stratum })),
  );
  const observations = [];
  for (let offset = 0; offset < selected.length; offset += 12) {
    const batch = selected.slice(offset, offset + 12);
    observations.push(
      ...(await Promise.all(
        batch.map(async (run) => {
          const jobs = [];
          let observed = 0;
          let totalCount: number | null = null;
          for (let page = 1; page <= 10; page += 1) {
            const data = parse(
              await gh([
                "api",
                "/repos/" + repo + "/actions/runs/" + run.id + "/jobs?per_page=100&page=" + page,
                "--jq",
                '{totalCount:.total_count,pageJobs:(.jobs|length),jobs:[.jobs[]|select(.name=="base-image-publication" or .name=="generate-matrix")|{name,status,conclusion,startedAt:.started_at,completedAt:.completed_at,steps:[.steps[]|{name,startedAt:.started_at,completedAt:.completed_at}]}]}',
              ]),
              "workflow job",
            );
            if (
              !Number.isSafeInteger(data.totalCount) ||
              data.totalCount < 0 ||
              !Number.isSafeInteger(data.pageJobs) ||
              data.pageJobs < 0 ||
              data.pageJobs > 100 ||
              !Array.isArray(data.jobs)
            )
              throw new Error("GitHub workflow job response is invalid");
            if (totalCount !== null && data.totalCount !== totalCount)
              throw new Error("GitHub workflow job count changed during pagination");
            totalCount = data.totalCount;
            observed += data.pageJobs;
            jobs.push(...data.jobs);
            if (observed >= totalCount) break;
            if (page === 10)
              throw new Error("GitHub workflow job data exceeded the 1,000-job pagination bound");
          }
          return {
            ...run,
            publication: jobs.find((job) => job.name === "base-image-publication") ?? null,
            matrix: jobs.find((job) => job.name === "generate-matrix") ?? null,
          };
        }),
      )),
    );
  }
  const elapsed = (start, end) => {
    if (!start || !end) return null;
    const first = Date.parse(start);
    const last = Date.parse(end);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
    return (last - first) / 1000;
  };
  const medianCi = medianConfidenceInterval;
  const stats = (raw) => {
    const values = raw.filter((value) => value !== null);
    if (values.length === 0) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const standardDeviation =
      values.length > 1
        ? Math.sqrt(
            values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1),
          )
        : 0;
    const margin = (1.96 * standardDeviation) / Math.sqrt(values.length);
    return {
      n: values.length,
      minSeconds: round(Math.min(...values)),
      medianSeconds: round(quantile(values, 0.5)),
      median95CiSeconds: medianCi(values),
      meanSeconds: round(mean),
      mean95CiSeconds: [round(mean - margin), round(mean + margin)],
      p90Seconds: round(quantile(values, 0.9)),
      p95Seconds: round(quantile(values, 0.95)),
      maxSeconds: round(Math.max(...values)),
    };
  };
  const summarize = (items) => {
    const outcomes = new Map();
    for (const item of items) {
      const outcome = item.publication
        ? item.publication.conclusion || item.publication.status
        : "missing";
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    }
    const good = items.filter((item) => item.publication?.conclusion === "success");
    const step = (item, name) => item.publication.steps?.find((value) => value.name === name) ?? {};
    return {
      selectedRuns: items.length,
      successfulJobs: good.length,
      atLeast30SuccessfulJobs: good.length >= 30,
      outcomes: [...outcomes.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, count })),
      jobExecution: stats(
        good.map((item) => elapsed(item.publication.startedAt, item.publication.completedAt)),
      ),
      verifier: stats(
        good.map((item) => {
          const value = step(item, "Verify applicable base-image publication");
          return elapsed(value.startedAt, value.completedAt);
        }),
      ),
      workflowCreationToCompletion: stats(
        good.map((item) => elapsed(item.createdAt, item.publication.completedAt)),
      ),
      runnerQueue: stats(good.map((item) => elapsed(item.createdAt, item.publication.startedAt))),
      boundaryToMatrixStart: stats(
        good.map((item) => elapsed(item.publication.completedAt, item.matrix?.startedAt)),
      ),
    };
  };
  const same = observations.filter((item) => item.stratum === "same-commit-publication");
  const reused = observations.filter((item) => item.stratum === "reuse-prior-publication");
  return {
    measuredAt: new Date().toISOString(),
    population: {
      completedE2eRuns: e2e.length,
      range: [e2e.at(-1)?.createdAt ?? null, e2e[0]?.createdAt ?? null],
      classified: {
        "same-commit-publication": groups["same-commit-publication"].length,
        "reuse-prior-publication": groups["reuse-prior-publication"].length,
      },
      method: `systematic sample of up to ${maxPerStratum} completed push runs per stratum; successful job durations are uncensored observations`,
    },
    sameCommitPublication: summarize(same),
    reusePriorPublication: summarize(reused),
    combined: summarize(observations),
  };
}

function parseCli(): Parameters<typeof analyzeBaseImagePublicationTimings>[0] {
  const { values } = parseArgs({
    options: {
      workdir: { type: "string" },
      repo: { type: "string" },
      "e2e-limit": { type: "string" },
      "base-limit": { type: "string" },
      "max-per-stratum": { type: "string" },
    },
    strict: true,
  });
  return {
    workdir: values.workdir ?? process.cwd(),
    repo: values.repo,
    e2eLimit: values["e2e-limit"] === undefined ? undefined : Number(values["e2e-limit"]),
    baseLimit: values["base-limit"] === undefined ? undefined : Number(values["base-limit"]),
    maxPerStratum:
      values["max-per-stratum"] === undefined ? undefined : Number(values["max-per-stratum"]),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  analyzeBaseImagePublicationTimings(parseCli())
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
