/**
 * Check and conditionally refresh multiple NemoClaw pull request branches at their expected latest PR commits.
 */
export default async function refresh_nemoclaw_pr_branches_from_base(input: {
  items: { number: Integer; expectedHeadSha: string }[];
  repo?: string;
  workdir: string;
  apply: boolean;
}): Promise<{
  apply: boolean;
  mutated: boolean;
  repo: string;
  requested: Integer;
  counts: {
    updated: Integer;
    unchanged: Integer;
    eligible: Integer;
    ineligible: Integer;
    failed: Integer;
  };
  results: {
    number: Integer;
    ok: boolean;
    error: string | null;
    apply: boolean;
    mutated: boolean;
    repo: string;
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
    } | null;
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
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!Array.isArray(input.items) || input.items.length === 0)
    throw new Error("items must contain at least one PR branch refresh");
  if (input.items.length > 25)
    throw new Error("items must contain 25 or fewer PR branch refreshes");
  const seen = new Set();
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.number) || item.number <= 0)
      throw new Error("each PR number must be a positive integer");
    if (!/^[0-9a-f]{40}$/.test(item.expectedHeadSha))
      throw new Error("each expectedHeadSha must be a lowercase 40-character commit SHA");
    if (seen.has(item.number)) throw new Error(`PR #${item.number} appears more than once`);
    seen.add(item.number);
  }
  const settled = await Promise.allSettled(
    input.items.map((item) =>
      tools.refresh_pr_branch_from_base({
        number: item.number,
        expectedHeadSha: item.expectedHeadSha,
        repo,
        workdir: input.workdir,
        apply: input.apply,
      }),
    ),
  );
  const results = settled.map((result, index) =>
    result.status === "fulfilled"
      ? { ...result.value, number: input.items[index].number, ok: true, error: null }
      : {
          number: input.items[index].number,
          ok: false,
          error: String(result.reason?.message ?? result.reason),
          apply: input.apply,
          mutated: false,
          repo,
          eligible: false,
          updated: false,
          wouldRequestBaseUpdate: false,
          reason: null,
          before: null,
          after: null,
          apiMessage: null,
          response: null,
        },
  );
  const accessFailure = results.find(
    (result) =>
      !result.ok &&
      /GitHub access failed|authentication|authorization|forbidden|permission/i.test(
        result.error ?? "",
      ),
  );
  if (accessFailure) throw new Error(accessFailure.error);
  return {
    apply: input.apply,
    mutated: results.some((result) => result.mutated),
    repo,
    requested: input.items.length,
    counts: {
      updated: results.filter((result) => result.updated).length,
      unchanged: results.filter((result) => result.ok && !result.updated).length,
      eligible: results.filter((result) => result.eligible).length,
      ineligible: results.filter((result) => result.ok && !result.eligible).length,
      failed: results.filter((result) => !result.ok).length,
    },
    results,
  };
}
