/**
 * Summarize configured required checks and pull request check states.
 */
export default async function summarize_nemoclaw_required_checks(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
  number: Integer;
  base?: string;
}): Promise<{
  repo: string;
  kind: string;
  truncated: boolean;
  items: Open<{}>[];
  summary: Open<{}>;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw",
    limit = input.limit ?? 100,
    base = input.base ?? "main";
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    !Number.isSafeInteger(input.number) ||
    input.number <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !/^[\w./-]+$/.test(base)
  )
    throw new Error("Invalid input");
  const [a, b] = await Promise.all([
    tools.run_github_cli({
      workdir: input.workdir,
      args: ["api", "repos/" + repo + "/branches/" + base + "/protection/required_status_checks"],
      acceptedExitCodes: [0, 1],
    }),
    tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "pr",
        "checks",
        String(input.number),
        "--repo",
        repo,
        "--json",
        "name,state,bucket,link",
      ],
      acceptedExitCodes: [0, 8],
    }),
  ]);
  const cfg = a.code === 0 ? JSON.parse(a.stdout) : { contexts: [], checks: [] },
    all = JSON.parse(b.stdout || "[]"),
    names = [...new Set([...(cfg.contexts ?? []), ...(cfg.checks ?? []).map((c) => c.context)])],
    items = names
      .slice(0, limit)
      .map((name) => ({ name, matches: all.filter((c) => c.name === name) }));
  return {
    repo,
    kind: "required-checks",
    truncated: names.length > limit,
    items,
    summary: {
      number: input.number,
      base,
      configured: names.length,
      protectionReadable: a.code === 0,
    },
  };
}
