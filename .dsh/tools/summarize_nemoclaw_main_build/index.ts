/**
 * Summarize a NemoClaw main build and compare its commit with the latest main commit through bounded GitHub reads.
 */
export default async function summarize_nemoclaw_main_build(input: {
  workdir: string;
  repo?: string;
  sha?: string;
  workflow?: string;
  includeCurrentMain?: boolean;
  maxRuns?: Integer;
}): Promise<{
  checkedAt: string;
  repo: string;
  workflow: string;
  targetSha: string;
  currentMain: string;
  targetIsCurrent: boolean;
  result:
    | "main-build-not-found"
    | "main-build-in-progress"
    | "main-build-passed"
    | "main-build-superseded"
    | "main-build-did-not-pass";
  targetRun: {
    id: Integer;
    sha: string;
    title: string;
    status: string;
    conclusion: string | null;
    createdAt: string;
    updatedAt: string;
    url: string;
    jobs: {
      total: Integer;
      counts: { name: string; count: Integer }[];
      nonPassing: {
        id: Integer;
        name: string;
        status: string;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
        html_url: string;
      }[];
      truncated: boolean;
    };
  } | null;
  currentRun: {
    id: Integer;
    sha: string;
    title: string;
    status: string;
    conclusion: string | null;
    createdAt: string;
    updatedAt: string;
    url: string;
    jobs: {
      total: Integer;
      counts: { name: string; count: Integer }[];
      nonPassing: {
        id: Integer;
        name: string;
        status: string;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
        html_url: string;
      }[];
      truncated: boolean;
    };
  } | null;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  const workflow = input.workflow ?? "main.yaml";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!/^[A-Za-z0-9_.\/-]+\.ya?ml$/.test(workflow))
    throw new Error("workflow must be a YAML workflow path or filename");
  if (input.sha && !/^[0-9a-f]{40}$/.test(input.sha))
    throw new Error("sha must be a full commit SHA");
  const limit = Math.min(Math.max(input.maxRuns ?? 25, 1), 100);
  const transient =
    /TLS handshake timeout|connection reset|temporar(?:y|ily)|HTTP 50[234]|unexpected EOF|i\/o timeout/i;
  const gh = async (args) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await tools.run_github_cli({
          workdir: input.workdir,
          args,
          timeoutMs: 30000,
        });
        return result.stdout;
      } catch (error) {
        if (!transient.test(String(error)) || attempt === 2) throw error;
        const pause = await tools.bash({
          command: "sleep " + String((attempt + 1) * 0.75),
          workdir: input.workdir,
          description: "Pause before bounded GitHub retry",
          timeoutMs: 3000,
        });
        if (pause.kind !== "foreground" || pause.exitCode !== 0) throw error;
      }
    }
    throw new Error("GitHub read retry bound was exhausted");
  };
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("GitHub returned invalid bounded JSON");
    }
  };
  const current = (await gh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"])).trim();
  const target = input.sha ?? current;
  const fields = "databaseId,headSha,status,conclusion,displayTitle,createdAt,updatedAt,url";
  const listed = parse(
    await gh([
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflow,
      "--branch",
      "main",
      "--limit",
      String(limit),
      "--json",
      fields,
    ]),
  );
  const find = async (sha) => {
    const existing = listed.find((run) => run.headSha === sha);
    if (existing) return existing;
    const exact = parse(
      await gh([
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        workflow,
        "--commit",
        sha,
        "--limit",
        "10",
        "--json",
        fields,
      ]),
    );
    return exact[0] ?? null;
  };
  const summarize = async (run) => {
    if (!run) return null;
    const jobs = [];
    for (let page = 1; page <= 2; page += 1) {
      const data = parse(
        await gh([
          "api",
          `repos/${repo}/actions/runs/${run.databaseId}/jobs?filter=latest&per_page=100&page=${page}`,
          "--jq",
          "{count:(.jobs|length),jobs:[.jobs[]|{id,name,status,conclusion,started_at,completed_at,html_url}]}",
        ]),
      );
      jobs.push(...data.jobs);
      if (data.count < 100) break;
    }
    const nonPassing = jobs
      .filter(
        (job) => job.status !== "completed" || !["success", "skipped"].includes(job.conclusion),
      )
      .slice(0, 30);
    const counts = new Map();
    for (const job of jobs) {
      const key = job.status !== "completed" ? job.status : job.conclusion || "none";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      id: run.databaseId,
      sha: run.headSha,
      title: run.displayTitle,
      status: run.status,
      conclusion: run.conclusion || null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      url: run.url,
      jobs: {
        total: jobs.length,
        counts: [...counts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => ({ name, count })),
        nonPassing,
        truncated: nonPassing.length >= 30 || jobs.length >= 200,
      },
    };
  };
  const targetRun = await summarize(await find(target));
  const currentRun =
    input.includeCurrentMain === false || current === target
      ? null
      : await summarize(await find(current));
  let result = "main-build-not-found";
  if (targetRun && targetRun.status !== "completed") result = "main-build-in-progress";
  else if (targetRun?.conclusion === "success") result = "main-build-passed";
  else if (targetRun?.conclusion === "cancelled" && target !== current)
    result = "main-build-superseded";
  else if (targetRun) result = "main-build-did-not-pass";
  return {
    checkedAt: new Date().toISOString(),
    repo,
    workflow,
    targetSha: target,
    currentMain: current,
    targetIsCurrent: target === current,
    result,
    targetRun,
    currentRun,
  };
}
