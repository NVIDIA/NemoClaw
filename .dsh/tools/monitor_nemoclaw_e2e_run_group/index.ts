/**
 * Monitor a bounded NemoClaw E2E run group and return bounded run and job summaries.
 */
export default async function monitor_nemoclaw_e2e_run_group(input: {
  workdir: string;
  runIds: Integer[];
  candidateSha: string;
  repo?: string;
  workflow?: string;
  branch?: string;
  timeoutMs?: Integer;
  intervalMs?: Integer;
  runLimit?: Integer;
  includeJobs?: boolean;
}): Promise<{
  checkedAt: string;
  repo: string;
  workflow: string;
  branch: string;
  candidateSha: string;
  terminal: boolean;
  reason: string | null;
  polls: Integer;
  runs: {
    runId: Integer;
    title: string | null;
    headSha: string | null;
    status: string | null;
    conclusion: string | null;
    url: string | null;
    missing: boolean;
  }[];
  jobSummaries: {
    runId: Integer;
    attempt: Integer | null;
    status: string | null;
    conclusion: string | null;
    counts: { state: string; count: Integer }[];
    failures: { name: string; url: string | null; failedSteps: string[] }[];
    remaining: { name: string; status: string | null; url: string | null }[];
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  const workflow = input.workflow ?? "e2e.yaml";
  const branch = input.branch ?? "main";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!/^[A-Za-z0-9_.\/-]+\.ya?ml$/.test(workflow))
    throw new Error("workflow must be a YAML workflow path or filename");
  if (!/^[A-Za-z0-9_.\/-]+$/.test(branch)) throw new Error("branch is invalid");
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha))
    throw new Error("candidateSha must be a full lowercase commit SHA");
  const runIds = [...new Set(input.runIds)];
  if (
    runIds.length === 0 ||
    runIds.length > 20 ||
    runIds.some((id) => !Number.isInteger(id) || id <= 0)
  )
    throw new Error("runIds must contain 1 to 20 positive run IDs");
  const timeoutMs = Math.max(0, Math.min(1800000, input.timeoutMs ?? 600000));
  const intervalMs = Math.max(5000, Math.min(120000, input.intervalMs ?? 30000));
  const runLimit = Math.max(runIds.length, Math.min(100, input.runLimit ?? 100));
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const cut = (value, size) => (typeof value === "string" ? value.slice(0, size) : null);
  const runGh = async (args) => {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args,
      timeoutMs: 60000,
    });
    try {
      return JSON.parse(result.stdout || "null");
    } catch {
      throw new Error("GitHub E2E run monitoring returned an invalid bounded response");
    }
  };
  const sleep = () => new Promise((resolve) => setTimeout(resolve, intervalMs));
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let selected = [];
  let reason = null;
  while (true) {
    polls += 1;
    const runs = await runGh([
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflow,
      "--branch",
      branch,
      "--limit",
      String(runLimit),
      "--json",
      "databaseId,displayTitle,headSha,status,conclusion,url",
    ]);
    selected = runIds.map(
      (runId) =>
        runs.find((run) => run.databaseId === runId) ?? { databaseId: runId, missing: true },
    );
    if (selected.some((run) => !run.missing && run.headSha !== input.candidateSha)) {
      reason = "candidate-commit-mismatch";
      break;
    }
    if (selected.every((run) => !run.missing && run.status === "completed")) break;
    if (Date.now() >= deadline) {
      reason = selected.some((run) => run.missing) ? "run-not-in-bounded-list" : "timeout";
      break;
    }
    await sleep();
  }
  const jobSummaries = [];
  if (input.includeJobs !== false) {
    for (const run of selected.filter((item) => !item.missing)) {
      const view = await runGh([
        "run",
        "view",
        String(run.databaseId),
        "--repo",
        repo,
        "--json",
        "status,conclusion,attempt,jobs",
      ]);
      const jobs = Array.isArray(view.jobs) ? view.jobs : [];
      const countMap = new Map();
      for (const job of jobs) {
        const state = job.conclusion || job.status || "unknown";
        countMap.set(state, (countMap.get(state) ?? 0) + 1);
      }
      const counts = [...countMap.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 30)
        .map(([state, count]) => ({ state: cut(state, 100) ?? "", count }));
      const failures = jobs
        .filter((job) => job.conclusion === "failure")
        .slice(0, 50)
        .map((job) => ({
          name: cut(job.name, 500) ?? "",
          url: cut(job.url, 2000),
          failedSteps: (Array.isArray(job.steps) ? job.steps : [])
            .filter((step) => step.conclusion === "failure")
            .slice(0, 100)
            .map((step) => cut(step.name, 500) ?? ""),
        }));
      const remaining = jobs
        .filter((job) => job.status !== "completed")
        .slice(0, 50)
        .map((job) => ({
          name: cut(job.name, 500) ?? "",
          status: cut(job.status, 100),
          url: cut(job.url, 2000),
        }));
      jobSummaries.push({
        runId: run.databaseId,
        attempt: Number.isInteger(view.attempt) ? view.attempt : null,
        status: cut(view.status, 100),
        conclusion: cut(view.conclusion, 100),
        counts,
        failures,
        remaining,
      });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    repo,
    workflow,
    branch,
    candidateSha: input.candidateSha,
    terminal: selected.every((run) => !run.missing && run.status === "completed"),
    reason,
    polls,
    runs: selected.map((run) => ({
      runId: run.databaseId,
      title: cut(run.displayTitle, 500),
      headSha: cut(run.headSha, 40),
      status: cut(run.status, 100),
      conclusion: cut(run.conclusion, 100),
      url: cut(run.url, 2000),
      missing: Boolean(run.missing),
    })),
    jobSummaries,
  };
}
