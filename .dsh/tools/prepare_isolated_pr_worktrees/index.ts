/**
 * Plan or prepare caller-isolated pull request worktrees by delegating each exact-commit worktree to the singular preparation tool.
 */
export default async function prepare_isolated_pr_worktrees(input: {
  workdir: string;
  numbers: Integer[];
  repo?: string;
  root: string;
  isolationKey?: string;
  remote?: string;
  reuseExisting?: boolean;
  replaceExisting?: boolean;
  requirePrimaryClean?: boolean;
  requireOpen?: boolean;
  failure?: "fail-fast" | "settled";
  dryRun?: boolean;
  apply?: true;
}): Promise<{
  dryRun: boolean;
  apply: boolean;
  mutated: boolean;
  repo: string;
  remote: string;
  root: string;
  isolationKey: string;
  failure: "fail-fast" | "settled";
  count: Integer;
  results: Open<{}>[];
  errors: { number: Integer; message: string }[];
}> {
  if (typeof input.workdir !== "string" || !input.workdir.trim())
    throw new Error("workdir is required");
  if (
    !Array.isArray(input.numbers) ||
    input.numbers.length === 0 ||
    input.numbers.length > 50 ||
    input.numbers.some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw new Error("numbers must contain 1 to 50 positive pull request numbers");
  if (typeof input.root !== "string" || !input.root.trim()) throw new Error("root is required");
  const numbers = [...new Set(input.numbers)],
    repo = input.repo ?? "NVIDIA/NemoClaw",
    root = input.root,
    remote = input.remote ?? "origin",
    reuseExisting = input.reuseExisting ?? false,
    replaceExisting = input.replaceExisting ?? false,
    requirePrimaryClean = input.requirePrimaryClean ?? false,
    requireOpen = input.requireOpen ?? true,
    dryRun = input.dryRun ?? true,
    failure = input.failure ?? "fail-fast";
  if (!["fail-fast", "settled"].includes(failure))
    throw new Error("failure must be fail-fast or settled");
  if (reuseExisting && replaceExisting)
    throw new Error("reuseExisting and replaceExisting cannot both be true");
  if (!dryRun && input.apply !== true)
    throw new Error("Worktree mutation requires dryRun:false and apply:true");
  let isolationKey = input.isolationKey;
  if (isolationKey === undefined) {
    const env = await tools.bash({
      command: "printf '%s' \"$DSH_SESSION_ID\"",
      workdir: input.workdir,
      description: "Read batch worktree isolation key",
      timeoutMs: 10000,
    });
    if (env.kind !== "foreground" || env.exitCode !== 0 || !env.stdout.text.trim())
      throw new Error("isolationKey is required outside a managed DSH session");
    isolationKey = env.stdout.text.trim();
  }
  const results = [],
    errors = [];
  for (const number of numbers) {
    try {
      const result = await tools.prepare_isolated_pr_worktree({
        workdir: input.workdir,
        number,
        repo,
        root,
        isolationKey,
        remote,
        reuseExisting,
        replaceExisting,
        requirePrimaryClean,
        requireOpen,
        dryRun,
        ...(!dryRun ? { apply: true } : {}),
      });
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ number, message });
      if (failure === "fail-fast") throw error;
    }
  }
  return {
    dryRun,
    apply: !dryRun,
    mutated: results.some((item) => item.mutated),
    repo,
    remote,
    root,
    isolationKey,
    failure,
    count: results.length,
    results,
    errors,
  };
}
