/**
 * Inspect a GitHub Actions job log with regex filtering, caller-selected head/tail clipping, and explicit truncation metadata.
 */
export default async function inspect_gh_job_log(input: {
  workdir: string;
  jobId: Integer | string;
  repo?: string;
  pattern?: string;
  contextLines?: Integer /** Maximum log lines to return after filtering; defaults to 120 and is capped at 500. */;
  maxLines?: Integer /** Which end of filtered output to retain when clipping; defaults to tail. */;
  clipMode?: "head" | "tail";
}): Promise<{
  jobId: string;
  repo: string;
  pattern: string | null;
  code: Integer;
  truncated: boolean;
  matchedLines: Integer;
  stdout: string;
  stderr: string;
  truncationNotice: string | null;
  truncationReasons: string[];
  clipMode: "head" | "tail";
  maxLines: Integer;
  selectedLines: Integer;
  returnedLines: Integer;
  omittedLines: Integer;
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  const jobId = String(input.jobId);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!/^\d+$/.test(jobId) || jobId === "0") throw new Error("jobId must be positive");
  const maxLines = Math.max(1, Math.min(500, input.maxLines ?? 120));
  const clipMode = input.clipMode ?? "tail";
  if (!new Set(["head", "tail"]).has(clipMode)) throw new Error("clipMode must be head or tail");
  const contextLines = Math.max(0, Math.min(80, input.contextLines ?? 20));
  const pattern = input.pattern ?? "";
  if (pattern.length > 500) throw new Error("pattern is too long");
  let matcher;
  try {
    matcher = new RegExp(pattern, "iu");
  } catch (error) {
    throw new Error(`Invalid pattern: ${String(error)}`);
  }
  const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const redact = (value) =>
    String(value)
      .replace(/(authorization\s*:)[^\r\n]*/gi, "$1 [REDACTED]")
      .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*=)\s*[^\s]+/g, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@")
      .replace(/\/(?:home|Users)\/[^/\s]+/g, "/[HOME]");
  const run = async (command, description, timeoutMs = 30000) => {
    const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
    if (result.kind !== "foreground") throw new Error("Unexpected background result");
    return result;
  };
  const temporary = await run(
    'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-job-log.XXXXXX"',
    "Create temporary job log directory",
  );
  if (temporary.exitCode !== 0) throw new Error("Could not create temporary job log directory");
  const directory = temporary.stdout.text.trim();
  if (!directory) throw new Error("Could not create temporary job log directory");
  let code = -1;
  let stderr = "";
  let stderrSourceTruncated = false;
  let stderrLineClipped = false;
  let stderrLineCharacterClipped = false;
  let stderrTextClipped = false;
  let lines = [];
  let sourceTruncated = false;
  try {
    const rawPath = directory + "/job.log";
    const boundedPath = directory + "/job.tail.log";
    const downloaded = await run(
      `gh api ${q(`repos/${repo}/actions/jobs/${jobId}/logs`)} > ${q(rawPath)}`,
      "Download GitHub Actions job log",
      60000,
    );
    code = downloaded.exitCode ?? -1;
    const projectedStderr = await tools.project_diagnostic_text({
      lines: [downloaded.stderr.text],
      clipMode: "tail",
      lineClipMode: "head",
      maxLines: 120,
      maxCharacters: 12000,
      maxLineCharacters: 4000,
      sourceTruncated: downloaded.stderr.truncated,
    });
    stderr = projectedStderr.text;
    stderrSourceTruncated = projectedStderr.sourceTruncated;
    stderrLineClipped = projectedStderr.lineClipped;
    stderrLineCharacterClipped = projectedStderr.lineCharacterClipped;
    stderrTextClipped = projectedStderr.textClipped;
    if (code === 0) {
      const bounded = await run(
        `bytes=$(wc -c < ${q(rawPath)}); lines=$(wc -l < ${q(rawPath)}); if [ "$bytes" -gt 4000000 ]; then tail -c 4000000 ${q(rawPath)} | sed '1d'; else cat -- ${q(rawPath)}; fi | tail -n 20000 > ${q(boundedPath)}; printf '%s %s' "$bytes" "$lines"`,
        "Bound downloaded GitHub job log",
      );
      if (bounded.exitCode !== 0) throw new Error("Could not bound downloaded job log");
      const [byteText, lineText] = bounded.stdout.text.trim().split(/\s+/, 2);
      const byteCount = Number(byteText);
      const lineCount = Number(lineText);
      sourceTruncated =
        (Number.isFinite(byteCount) && byteCount > 4000000) ||
        (Number.isFinite(lineCount) && lineCount > 20000);
      const content = await tools.read({ file_path: boundedPath, limit: 20000 });
      lines = content.lines.map((line) => line.text);
      sourceTruncated ||= content.totalLines > content.lines.length;
    }
  } finally {
    await run(`rm -rf -- ${q(directory)}`, "Remove temporary job log directory");
  }
  let matchedLines = 0;
  let selected = lines;
  if (pattern) {
    const indexes = new Set();
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher.test(lines[index])) continue;
      matchedLines += 1;
      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length, index + contextLines + 1);
      for (let selectedIndex = start; selectedIndex < end; selectedIndex += 1)
        indexes.add(selectedIndex);
    }
    selected = [...indexes].sort((a, b) => a - b).map((index) => lines[index]);
  }
  const projected = await tools.project_diagnostic_text({
    lines: selected,
    clipMode,
    lineClipMode: "head",
    maxLines,
    maxCharacters: 39999,
    maxLineCharacters: 4000,
    sourceTruncated,
  });
  const lineClipped = projected.lineClipped;
  const characterClipped = projected.lineCharacterClipped;
  const byteClipped = projected.textClipped;
  const truncated =
    projected.truncated ||
    stderrSourceTruncated ||
    stderrLineClipped ||
    stderrLineCharacterClipped ||
    stderrTextClipped;
  const truncationReasons = [
    ...(sourceTruncated ? ["source-log-bounded-before-filtering"] : []),
    ...(lineClipped ? ["selected-lines-exceeded-maxLines"] : []),
    ...(characterClipped ? ["selected-line-exceeded-4000-characters"] : []),
    ...(byteClipped ? ["selected-text-exceeded-40000-characters"] : []),
    ...(stderrSourceTruncated ? ["github-stderr-source-truncated"] : []),
    ...(stderrLineClipped ? ["github-stderr-exceeded-120-lines"] : []),
    ...(stderrLineCharacterClipped ? ["github-stderr-line-exceeded-4000-characters"] : []),
    ...(stderrTextClipped ? ["github-stderr-exceeded-12000-characters"] : []),
  ];
  return {
    jobId,
    repo,
    pattern: input.pattern ?? null,
    code,
    truncated,
    truncationNotice: truncated
      ? "TRUNCATED OUTPUT: do not assume omitted log lines are irrelevant or absent."
      : null,
    truncationReasons,
    clipMode,
    maxLines,
    selectedLines: projected.selectedLines,
    returnedLines: projected.returnedLines,
    omittedLines: projected.omittedLines,
    matchedLines,
    stdout: redact(projected.text),
    stderr,
  };
}
