/**
 * Check a pull request branch and request a base update only when apply is true.
 */
export default async function refresh_pr_branch_from_base(input: {
  number: Integer;
  expectedHeadSha: string;
  repo?: string;
  workdir: string;
  apply: boolean;
}): Promise<{
  apply: boolean;
  mutated: boolean;
  repo: string;
  number: Integer;
  eligible: boolean;
  updated: boolean;
  wouldRequestBaseUpdate: boolean;
  reason: string | null;
  before: {
    number: Integer;
    url: string;
    state: string;
    isDraft: boolean;
    headRefOid: string;
    baseRefName: string;
    headRefName: string;
    mergeable: string;
    mergeStateStatus: string;
  };
  after: {
    number: Integer;
    url: string;
    state: string;
    isDraft: boolean;
    headRefOid: string;
    baseRefName: string;
    headRefName: string;
    mergeable: string;
    mergeStateStatus: string;
  } | null;
  apiMessage: string | null;
  response: { code: Integer; stdout: string; stderr: string } | null;
}> {
  const authPattern =
    /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]|SSO/i;
  if (!Number.isSafeInteger(input.number) || input.number <= 0)
    throw new Error("number must be a positive integer");
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
    throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
  const view = async () => {
    const [pr, detailResult] = await Promise.all([
      tools.read_nemoclaw_pr({
        workdir: input.workdir,
        number: input.number,
        repository: repo,
      }),
      tools.run_github_cli({
        workdir: input.workdir,
        args: ["pr", "view", String(input.number), "--repo", repo, "--json", "headRefName"],
        timeoutMs: 30000,
      }),
    ]);
    return { ...pr, headRefName: JSON.parse(detailResult.stdout).headRefName ?? "" };
  };
  const before = await view();
  if (before.headRefOid !== input.expectedHeadSha)
    throw new Error(
      `PR #${input.number} commit changed: expected ${input.expectedHeadSha}, found ${before.headRefOid}`,
    );
  const eligible =
    before.state === "OPEN" && before.isDraft !== true && before.mergeable !== "CONFLICTING";
  const base = {
    apply: input.apply,
    mutated: false,
    repo,
    number: input.number,
    eligible,
    updated: false,
    wouldRequestBaseUpdate: eligible,
    reason: null,
    before,
    after: null,
    apiMessage: null,
    response: null,
  };
  if (!input.apply) return base;
  if (before.state !== "OPEN")
    throw new Error(
      `PR #${input.number} is ${String(before.state).toLowerCase()}; base update requires an open PR`,
    );
  if (before.isDraft === true)
    throw new Error(`PR #${input.number} is a draft; make the PR ready before updating its branch`);
  if (before.mergeable === "CONFLICTING")
    return {
      ...base,
      reason:
        "GitHub reports merge conflicts; resolve them only after confirming the intended behavior",
    };
  const update = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "api",
      "--method",
      "PUT",
      `repos/${repo}/pulls/${input.number}/update-branch`,
      "-f",
      `expected_head_sha=${before.headRefOid}`,
    ],
    acceptedExitCodes: [0, 1],
    timeoutMs: 30000,
    apply: true,
  });
  if (update.code !== 0) {
    const detail = update.stdout + "\n" + update.stderr;
    if (authPattern.test(detail)) {
      const diagnostic = await tools.project_diagnostic_text({
        lines: [update.stderr],
        clipMode: "tail",
        maxLines: 1,
        maxCharacters: 4000000,
        maxLineCharacters: 4000000,
      });
      throw new Error(
        `GitHub access failed while updating PR #${input.number}; stop and restore repository access before continuing.\n${diagnostic.text}`,
      );
    }
    const [stdout, stderr] = await Promise.all([
      tools.project_diagnostic_text({
        lines: [update.stdout],
        clipMode: "tail",
        maxLines: 1,
        maxCharacters: 2000,
        maxLineCharacters: 4000000,
      }),
      tools.project_diagnostic_text({
        lines: [update.stderr],
        clipMode: "tail",
        maxLines: 1,
        maxCharacters: 2000,
        maxLineCharacters: 4000000,
      }),
    ]);
    return {
      ...base,
      reason: "GitHub did not update the PR branch",
      response: {
        code: update.code,
        stdout: stdout.text,
        stderr: stderr.text,
      },
    };
  }
  let after = before;
  for (let attempt = 0; attempt < 12; attempt++) {
    await tools.bash({
      command: "sleep 2.5",
      workdir: input.workdir,
      description: "Wait for GitHub branch update",
      timeoutMs: 5000,
    });
    after = await view();
    if (after.headRefOid !== before.headRefOid) break;
  }
  let apiMessage = null;
  try {
    apiMessage = JSON.parse(update.stdout).message ?? null;
  } catch {}
  const updated = after.headRefOid !== before.headRefOid;
  return { ...base, mutated: updated, updated, after, apiMessage };
}
