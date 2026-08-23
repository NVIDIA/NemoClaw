/**
 * Detect changed docs and run guarded documentation validation.
 */
export default async function run_docs_validation_for_changed_docs(input: {
  workdir: string;
  baseRef?: string;
  runDocs?: boolean;
  dryRun?: boolean;
}): Promise<{
  ok: boolean;
  dryRun: boolean;
  baseRef: string;
  changed: string[];
  docsChanged: string[];
  planned: string[];
  steps: {
    name: string;
    code: Integer;
    stdoutTail: string;
    stderrTail: string;
    truncated: boolean;
  }[];
  clean: boolean | null;
}> {
  const baseRef = input.baseRef ?? "origin/main",
    dryRun = input.dryRun ?? true;
  if (baseRef.startsWith("-") || !/^[A-Za-z0-9_./-]{1,200}$/.test(baseRef))
    throw new Error("baseRef is invalid");
  const inferred = await tools.infer_validation_for_changed_files({
    workdir: input.workdir,
    baseRef,
  });
  const changed = inferred.files,
    docsChanged = changed.filter(
      (f) => /^(docs|fern)\//.test(f) || ["docs/index.yml", "fern/fern.config.json"].includes(f),
    );
  const planned = [];
  if (docsChanged.some((f) => f.endsWith(".mdx") || f === "docs/index.yml"))
    planned.push("npm run docs:sync-agent-variants");
  if (input.runDocs !== false && docsChanged.length) planned.push("npm run docs");
  const steps = [];
  if (!dryRun)
    for (const command of planned) {
      const r = await tools.bash({
        command,
        workdir: input.workdir,
        description: "Validate changed documentation",
        timeoutMs: command === "npm run docs" ? 300000 : 180000,
      });
      if (r.kind !== "foreground") throw new Error("Unexpected background result");
      const [stdoutTail, stderrTail] = await Promise.all([
        tools.project_diagnostic_text({
          lines: [r.stdout.text],
          clipMode: "tail",
          maxLines: 1,
          maxCharacters: 6000,
          maxLineCharacters: 4000000,
          sourceTruncated: r.stdout.truncated,
        }),
        tools.project_diagnostic_text({
          lines: [r.stderr.text],
          clipMode: "tail",
          maxLines: 1,
          maxCharacters: 6000,
          maxLineCharacters: 4000000,
          sourceTruncated: r.stderr.truncated,
        }),
      ]);
      steps.push({
        name: command,
        code: r.exitCode ?? -1,
        stdoutTail: stdoutTail.text,
        stderrTail: stderrTail.text,
        truncated: r.stdout.truncated || r.stderr.truncated,
      });
      if ((r.exitCode ?? -1) !== 0) break;
    }
  const identity = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: true,
  });
  return {
    ok: steps.every((x) => x.code === 0),
    dryRun,
    baseRef,
    changed,
    docsChanged,
    planned,
    steps,
    clean: identity.clean,
  };
}
