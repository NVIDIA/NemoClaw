/**
 * Measure bounded base-image publication gate latency samples from recent NemoClaw main-push E2E runs.
 */
export default async function analyze_base_image_publication_timings(input: {
  workdir: string;
  repo?: string;
  e2eLimit?: Integer;
  baseLimit?: Integer;
  maxPerStratum?: Integer;
}): Promise<{
  measuredAt: string;
  population: {
    completedE2eRuns: Integer;
    range: (string | null)[];
    classified: { "same-commit-publication": Integer; "reuse-prior-publication": Integer };
    method: string;
  };
  sameCommitPublication: {
    selectedRuns: Integer;
    successfulJobs: Integer;
    atLeast30SuccessfulJobs: boolean;
    outcomes: { name: string; count: Integer }[];
    jobExecution: {
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
    selectedRuns: Integer;
    successfulJobs: Integer;
    atLeast30SuccessfulJobs: boolean;
    outcomes: { name: string; count: Integer }[];
    jobExecution: {
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
    selectedRuns: Integer;
    successfulJobs: Integer;
    atLeast30SuccessfulJobs: boolean;
    outcomes: { name: string; count: Integer }[];
    jobExecution: {
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
      n: Integer;
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
  const e2eLimit = Math.max(30, Math.min(500, input.e2eLimit ?? 300));
  const baseLimit = Math.max(e2eLimit, Math.min(500, input.baseLimit ?? 500));
  const maxPerStratum = Math.max(30, Math.min(200, input.maxPerStratum ?? 150));
  const gh = async (args, timeoutMs = 60000) => {
    const result = await tools.run_github_cli({ workdir: input.workdir, args, timeoutMs });
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
          const data = parse(
            await gh([
              "api",
              "/repos/" + repo + "/actions/runs/" + run.id + "/jobs?per_page=100",
              "--paginate",
              "--slurp",
              "--jq",
              '{jobs:[.[].jobs[]|select(.name=="base-image-publication" or .name=="generate-matrix")|{name,status,conclusion,startedAt:.started_at,completedAt:.completed_at,steps:[.steps[]|{name,startedAt:.started_at,completedAt:.completed_at}]}]}',
            ]),
            "workflow job",
          );
          return {
            ...run,
            publication: data.jobs.find((job) => job.name === "base-image-publication") ?? null,
            matrix: data.jobs.find((job) => job.name === "generate-matrix") ?? null,
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
  const quantile = (values, q) => {
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    return (
      sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (position - low)
    );
  };
  const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
  const medianCi = (values) => {
    if (values.length < 2) return [round(values[0] ?? null), round(values[0] ?? null)];
    let seed = 0x7372;
    const estimates = [];
    for (let iteration = 0; iteration < 3000; iteration += 1) {
      const sample = values.map(() => {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        return values[Math.floor((seed / 4294967296) * values.length)];
      });
      estimates.push(quantile(sample, 0.5));
    }
    return [round(quantile(estimates, 0.025)), round(quantile(estimates, 0.975))];
  };
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
