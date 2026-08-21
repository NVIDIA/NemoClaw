/**
 * Run guarded focused validation for a NemoClaw repair.
 */
export default async function run_nemoclaw_focused_repair_validation(input: {
  workdir: string;
  files?: string[];
  testFiles?: string[];
  projects?: string[];
  baseRef?: string;
  formatWrite?: boolean;
  typecheckCli?: boolean;
  typecheckPlugin?: boolean;
  repoChecks?: boolean;
  diffCheck?: boolean;
  nulCheck?: boolean;
  docs?: boolean;
  timeoutMs?: Integer;
  dryRun?: boolean;
}): Promise<{
  ok: boolean;
  dryRun: boolean;
  baseRef: string;
  files: string[];
  tests: string[];
  projects: string[];
  inferred: {
    baseRef: string;
    files: string[];
    branchFiles: string[];
    workingTreeFiles: string[];
    untrackedFiles: string[];
    projects: string[];
    targetedFiles: string[];
    commands: string[];
    notes: string[];
  };
  planned: { name: string; command: string; mutates?: boolean }[];
  steps: {
    name: string;
    command: string;
    code: Integer;
    stdoutTail: string;
    stderrTail: string;
    truncated: boolean;
  }[];
  failed: {
    name: string;
    command: string;
    code: Integer;
    stdoutTail: string;
    stderrTail: string;
    truncated: boolean;
  }[];
  nul: null | {
    ok: boolean;
    checked: Integer;
    files: string[];
    findings: { file: string; count: Integer }[];
    changed: {
      baseRef: string;
      files: string[];
      branchFiles: string[];
      workingTreeFiles: string[];
      untrackedFiles: string[];
    };
  };
}> {
  const baseRef = input.baseRef ?? "origin/main",
    dryRun = input.dryRun ?? true,
    timeoutMs = Math.max(30000, Math.min(300000, input.timeoutMs ?? 180000));
  const inferred = await tools.infer_validation_for_changed_files({
    workdir: input.workdir,
    baseRef,
  });
  const files = input.files ?? inferred.files,
    tests = input.testFiles ?? inferred.targetedFiles,
    projects = input.projects ?? inferred.projects,
    safe = /^[A-Za-z0-9_./@-]+$/;
  if (!files.every((x) => safe.test(x)) || !tests.every((x) => safe.test(x)))
    throw new Error("File paths contain unsupported characters");
  const allowed = new Set([
    "cli",
    "integration",
    "installer-integration",
    "package-contract",
    "plugin",
    "e2e-support",
  ]);
  if (!projects.every((x) => allowed.has(x))) throw new Error("Unsupported Vitest project");
  const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'",
    commands = [],
    oxc = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  if (oxc.length) {
    const mode = (input.formatWrite ?? true) ? "--write" : "--check";
    commands.push(
      {
        name: "Oxfmt",
        command:
          "NEMOCLAW_FORMAT_BASE_REF=" +
          q(baseRef) +
          " bash tools/lint/format-added-files.sh " +
          mode +
          " " +
          oxc.map(q).join(" "),
        mutates: mode === "--write",
      },
      {
        name: "Oxlint",
        command:
          "npx --no-install oxlint --no-error-on-unmatched-pattern -- " + oxc.map(q).join(" "),
      },
    );
  }
  if (
    input.typecheckCli === true ||
    (input.typecheckCli !== false &&
      files.some((f) => f.startsWith("src/") && /\.[cm]?tsx?$/.test(f)))
  )
    commands.push({ name: "CLI typecheck", command: "npm run typecheck:cli" });
  if (
    input.typecheckPlugin === true ||
    (input.typecheckPlugin !== false &&
      files.some((f) => f.startsWith("nemoclaw/") && /\.[cm]?tsx?$/.test(f)))
  )
    commands.push({ name: "Plugin typecheck", command: "npm --prefix nemoclaw run typecheck" });
  if (input.repoChecks !== false)
    commands.push({ name: "Repository checks", command: "npm run checks:repository" });
  if (tests.length)
    commands.push({
      name: "Focused Vitest",
      command: ["npx", "vitest", "run", ...projects.flatMap((p) => ["--project", p]), ...tests]
        .map(q)
        .join(" "),
    });
  if (
    input.docs === true ||
    (input.docs !== false && files.some((f) => f.startsWith("docs/") || f.startsWith("fern/")))
  )
    commands.push({ name: "Docs validation", command: "npm run docs", mutates: true });
  if (input.diffCheck !== false)
    commands.push(
      {
        name: "Branch diff whitespace check",
        command: "git diff --check " + q(baseRef + "...HEAD") + " --",
      },
      { name: "Working-tree whitespace check", command: "git diff --check HEAD --" },
    );
  if (dryRun)
    return {
      ok: true,
      dryRun,
      baseRef,
      files,
      tests,
      projects,
      inferred,
      planned: commands,
      steps: [],
      failed: [],
      nul: null,
    };
  const steps = [];
  for (const item of commands) {
    const r = await tools.bash({
      command: item.command,
      workdir: input.workdir,
      description: "Run focused repair validation",
      timeoutMs,
    });
    if (r.kind !== "foreground") throw new Error("Unexpected background result");
    const [stdoutTail, stderrTail] = await Promise.all([
      tools.project_diagnostic_text({
        lines: r.stdout.text.split(/\r?\n/),
        clipMode: "tail",
        maxLines: 80,
        maxCharacters: 4000000,
        maxLineCharacters: 4000000,
        sourceTruncated: r.stdout.truncated,
      }),
      tools.project_diagnostic_text({
        lines: r.stderr.text.split(/\r?\n/),
        clipMode: "tail",
        maxLines: 80,
        maxCharacters: 4000000,
        maxLineCharacters: 4000000,
        sourceTruncated: r.stderr.truncated,
      }),
    ]);
    steps.push({
      name: item.name,
      command: item.command,
      code: r.exitCode ?? -1,
      stdoutTail: stdoutTail.text,
      stderrTail: stderrTail.text,
      truncated: r.stdout.truncated || r.stderr.truncated,
    });
  }
  let nul = null;
  if (input.nulCheck !== false)
    nul = await tools.check_changed_files_for_nul_bytes({ workdir: input.workdir, baseRef });
  if (nul)
    steps.push({
      name: "NUL byte check",
      command: "check_changed_files_for_nul_bytes",
      code: nul.ok ? 0 : 1,
      stdoutTail: JSON.stringify(nul),
      stderrTail: "",
      truncated: false,
    });
  const failed = steps.filter((s) => s.code !== 0);
  return {
    ok: failed.length === 0,
    dryRun,
    baseRef,
    files,
    tests,
    projects,
    inferred,
    planned: commands,
    steps,
    failed,
    nul,
  };
}
