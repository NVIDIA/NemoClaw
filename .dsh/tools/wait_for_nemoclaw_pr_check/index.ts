/**
 * Wait for one named GitHub check on the latest PR commit.
 */
export default async function wait_for_nemoclaw_pr_check(input: {
  workdir: string;
  number: Integer;
  name: string;
  repo?: string;
  expectedHeadSha?: string;
  timeoutMs?: Integer;
  intervalMs?: Integer;
}): Promise<{
  done: boolean;
  stale: boolean;
  reason: string | null;
  repo: string;
  number: Integer;
  prUrl: string | null;
  headSha: string;
  currentHeadSha: string | null;
  name: string;
  check: {
    id: Integer;
    status: string | null;
    conclusion: string | null;
    detailsUrl: string | null;
    startedAt: string | null;
    completedAt: string | null;
    app: string | null;
  } | null;
}> {
  if (!Number.isInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  const name = input.name.trim();
  if (!name) throw new Error("check name is required");
  if (name.length > 500) throw new Error("check name is too long");
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (input.expectedHeadSha && !/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
    throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
  const timeoutMs = Math.max(1000, Math.min(1800000, input.timeoutMs ?? 600000));
  const intervalMs = Math.max(1000, Math.min(120000, input.intervalMs ?? 15000));
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
      throw new Error("GitHub pull request check read returned an invalid bounded response");
    }
  };
  const readHead = () =>
    runGh(["pr", "view", String(input.number), "--repo", repo, "--json", "headRefOid,url,title"]);
  const checkView = (check) => {
    if (!check) return null;
    return {
      id: Number.isInteger(check.id) ? check.id : 0,
      status: cut(check.status, 100),
      conclusion: cut(check.conclusion, 100),
      detailsUrl: cut(check.details_url, 2000),
      startedAt: cut(check.started_at, 100),
      completedAt: cut(check.completed_at, 100),
      app: cut(check.app?.slug || check.app?.name, 500),
    };
  };
  const initial = await readHead();
  const headSha = String(initial?.headRefOid || "");
  if (!/^[0-9a-f]{40}$/.test(headSha))
    throw new Error(`PR #${input.number} returned an invalid commit SHA`);
  if (input.expectedHeadSha && headSha !== input.expectedHeadSha)
    throw new Error(
      `PR #${input.number} commit changed: expected ${input.expectedHeadSha}, found ${headSha}`,
    );
  const base = {
    repo,
    number: input.number,
    prUrl: cut(initial?.url, 2000),
    headSha,
    name,
  };
  const deadline = Date.now() + timeoutMs;
  let last = null,
    currentInterval = intervalMs,
    lastFingerprint = null;
  while (Date.now() <= deadline) {
    const current = await readHead();
    const currentHeadSha = String(current?.headRefOid || "");
    if (currentHeadSha !== headSha) {
      return {
        done: false,
        stale: true,
        reason: null,
        ...base,
        currentHeadSha: cut(currentHeadSha, 40),
        check: checkView(last),
      };
    }
    const payload = await runGh([
      "api",
      `repos/${repo}/commits/${headSha}/check-runs`,
      "-X",
      "GET",
      "-f",
      `check_name=${name}`,
      "-f",
      "filter=latest",
      "-f",
      "per_page=100",
    ]);
    const matches = (Array.isArray(payload?.check_runs) ? payload.check_runs : [])
      .filter((check) => check.name === name)
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0));
    last = matches[0] ?? null;
    if (last?.status === "completed") {
      return {
        done: true,
        stale: false,
        reason: null,
        ...base,
        currentHeadSha: null,
        check: checkView(last),
      };
    }
    const fingerprint = JSON.stringify([
      currentHeadSha,
      Number.isInteger(last?.id) ? last.id : null,
      last?.status ?? null,
      last?.conclusion ?? null,
    ]);
    if (lastFingerprint === null || fingerprint !== lastFingerprint) currentInterval = intervalMs;
    else currentInterval = Math.min(Math.max(60000, intervalMs), currentInterval * 2);
    lastFingerprint = fingerprint;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(currentInterval, remainingMs)));
  }
  return {
    done: false,
    stale: false,
    reason: "timeout",
    ...base,
    currentHeadSha: null,
    check: checkView(last),
  };
}
