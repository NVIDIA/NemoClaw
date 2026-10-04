/**
 * Run focused Vitest files with selected projects, bounded head/tail output, and explicit truncation metadata.
 */
export default async function run_targeted_vitest(input: {
  workdir: string;
  files: string[];
  projects?: (
    | "cli"
    | "integration"
    | "installer-integration"
    | "package-contract"
    | "plugin"
    | "e2e-support"
  )[];
  coverage?: boolean;
  timeoutMs?: Integer /** Maximum lines returned from each output stream; defaults to 120 and is capped at 500. */;
  maxLines?: Integer /** Which end of each output stream to retain when clipping; defaults to tail. */;
  clipMode?: "head" | "tail";
}): Promise<{
  command: string;
  code: Integer;
  stdout: string;
  stderr: string;
  truncated: boolean;
  truncationNotice: string | null;
  truncationReasons: string[];
  clipMode: "head" | "tail";
  maxLines: Integer;
  stdoutTotalLines: Integer;
  stdoutReturnedLines: Integer;
  stderrTotalLines: Integer;
  stderrReturnedLines: Integer;
}> {
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 100)
    throw new Error("files must contain 1 to 100 test files");
  const allowed = new Set([
    "cli",
    "integration",
    "installer-integration",
    "package-contract",
    "plugin",
    "e2e-support",
  ]);
  if (input.projects && (!Array.isArray(input.projects) || input.projects.length > 6))
    throw new Error("projects must contain at most 6 entries");
  const projects = input.projects?.length ? [...new Set(input.projects)] : ["cli", "integration"];
  const invalid = projects.filter((x) => !allowed.has(x));
  if (invalid.length) throw new Error(`Unsupported Vitest project(s): ${invalid.join(", ")}`);
  const repoRelative = (value, maxLength) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => part === ".." || part === ".") &&
    /^[A-Za-z0-9_./@-]+$/.test(value);
  if (!input.files.every((x) => repoRelative(x, 4096)))
    throw new Error(
      "Test files must be non-option repository-relative paths of at most 4096 characters",
    );
  if (!projects.every((x) => repoRelative(x, 128)))
    throw new Error(
      "Vitest projects must be non-option repository-relative names of at most 128 characters",
    );
  const quote = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
  const args = ["vitest", "run", ...projects.flatMap((x) => ["--project", x]), ...input.files];
  if (input.coverage)
    args.push(
      "--coverage",
      "--coverage.reporter=json-summary",
      "--coverage.reportsDirectory=coverage/targeted",
      "--coverage.include=bin/**/*.js",
      "--coverage.include=src/**/*.ts",
      "--coverage.exclude=test/**/*.js",
      "--coverage.exclude=test/**/*.ts",
    );
  const timeoutMs = Math.max(30000, Math.min(300000, input.timeoutMs ?? 180000));
  const maxLines = Math.max(1, Math.min(500, input.maxLines ?? 120));
  const clipMode = input.clipMode ?? "tail";
  if (!new Set(["head", "tail"]).has(clipMode)) throw new Error("clipMode must be head or tail");
  const command = "npx " + args.map(quote).join(" ");
  const result = await tools.bash({
    command,
    workdir: input.workdir,
    description: "Run selected Vitest files",
    timeoutMs,
  });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  const [stdout, stderr] = await Promise.all([
    tools.project_diagnostic_text({
      lines: String(result.stdout.text).split(/\r?\n/),
      clipMode,
      maxLines,
      maxCharacters: 4000000,
      maxLineCharacters: 4000000,
      sourceTruncated: result.stdout.truncated,
    }),
    tools.project_diagnostic_text({
      lines: String(result.stderr.text).split(/\r?\n/),
      clipMode,
      maxLines,
      maxCharacters: 4000000,
      maxLineCharacters: 4000000,
      sourceTruncated: result.stderr.truncated,
    }),
  ]);
  const transportTruncated = stdout.sourceTruncated || stderr.sourceTruncated;
  const stdoutClipped = stdout.lineClipped;
  const stderrClipped = stderr.lineClipped;
  const truncated = stdout.truncated || stderr.truncated;
  return {
    command,
    code: result.exitCode ?? -1,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated,
    truncationNotice: truncated
      ? "TRUNCATED OUTPUT: do not assume omitted test output is irrelevant or absent."
      : null,
    truncationReasons: [
      ...(transportTruncated ? ["tool-transport-truncated"] : []),
      ...(stdoutClipped ? ["stdout-exceeded-maxLines"] : []),
      ...(stderrClipped ? ["stderr-exceeded-maxLines"] : []),
    ],
    clipMode,
    maxLines,
    stdoutTotalLines: stdout.selectedLines,
    stdoutReturnedLines: stdout.returnedLines,
    stderrTotalLines: stderr.selectedLines,
    stderrReturnedLines: stderr.returnedLines,
  };
}
