/**
 * Summarize required-check, review, and merge conditions for a bounded batch of NemoClaw pull requests.
 */
export default async function summarize_nemoclaw_pr_readiness_batch(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
  numbers: Integer[];
}): Promise<{
  repo: string;
  kind: string;
  truncated: boolean;
  items: {
    number: Integer;
    pull: {
      url: string;
      state: string;
      headRefOid: string;
      baseRefOid: string;
      mergeStateStatus: string;
      reviewDecision: string;
    };
    failed: {
      name: string;
      state: string;
      bucket: string;
      link: string;
    }[];
    pending: {
      name: string;
      state: string;
      bucket: string;
      link: string;
    }[];
  }[];
  summary: {
    requested: Integer;
    summarized: Integer;
  };
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    limit = input.limit ?? 25;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !Array.isArray(input.numbers) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    input.numbers.some((n) => !Number.isSafeInteger(n) || n <= 0)
  )
    throw new Error("Invalid input");
  const nums = [...new Set(input.numbers)].slice(0, limit),
    items = [];
  for (const number of nums) {
    const s = await tools.collect_pr_feedback({
      repository: repo,
      pullNumber: number,
      workdir: input.workdir,
      bodyLimit: 500,
    });
    items.push({
      number,
      pull: s.pull,
      failed: s.checks.filter((c) =>
        ["fail", "failure", "cancelled", "timed_out", "action_required"].includes(
          c.state.toLowerCase(),
        ),
      ),
      pending: s.checks.filter((c) =>
        ["pending", "queued", "in_progress", "waiting", "requested"].includes(
          c.state.toLowerCase(),
        ),
      ),
    });
  }
  return {
    repo,
    kind: "pr-readiness-batch",
    truncated: new Set(input.numbers).size > nums.length,
    items,
    summary: { requested: input.numbers.length, summarized: items.length },
  };
}
