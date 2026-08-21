/**
 * Report NUL bytes in existing branch and working-tree files.
 */
export default async function check_changed_files_for_nul_bytes(input: {
  workdir: string;
  baseRef?: string;
}): Promise<{
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
}> {
  const changed = await tools.list_nemoclaw_changed_files({
    workdir: input.workdir,
    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
  });
  if (changed.files.length === 0) return { ok: true, checked: 0, files: [], findings: [], changed };
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const files = [];
  const findings = [];
  const deadline = Date.now() + 30000;
  for (const file of changed.files) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Could not scan changed files");
    const result = await tools.bash({
      command:
        "set -o pipefail; if [ ! -f " +
        quote(file) +
        " ]; then exit 3; fi; LC_ALL=C od -An -v -t u1 -- " +
        quote(file) +
        " | awk '{ for (i = 1; i <= NF; i++) if ($i == 0) count++ } END { print count + 0 }'",
      workdir: input.workdir,
      description: "Count NUL bytes in changed file",
      timeoutMs: remainingMs,
    });
    if (result.kind !== "foreground") throw new Error("Could not scan changed files");
    if (result.exitCode === 3) continue;
    if (result.exitCode !== 0) throw new Error("Could not scan changed files");
    const countText = result.stdout.text.trim();
    if (!/^\d+$/.test(countText)) throw new Error("Could not scan changed files");
    const count = Number(countText);
    files.push(file);
    if (count > 0) findings.push({ file, count });
  }
  return {
    ok: findings.length === 0,
    checked: files.length,
    files,
    findings,
    changed,
  };
}
