/**
 * List complete branch and working-tree file changes, rejecting truncated or oversized inventories.
 */
export default async function list_nemoclaw_changed_files(input: {
  workdir: string;
  baseRef?: string;
}): Promise<{
  baseRef: string;
  files: string[];
  branchFiles: string[];
  workingTreeFiles: string[];
  untrackedFiles: string[];
}> {
  const baseRef = input.baseRef ?? "origin/main";
  if (!baseRef.trim() || baseRef.length > 200 || baseRef.startsWith("-"))
    throw new Error("baseRef must contain 1 to 200 characters and must not start with a hyphen");
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const commands = [
    `git diff --name-only -z --diff-filter=ACMRTUXB ${quote(baseRef + "...HEAD")} --`,
    "git diff --name-only -z --diff-filter=ACMRTUXB HEAD --",
    "git ls-files --others --exclude-standard -z",
  ];
  const results = [];
  for (const command of commands)
    results.push(
      await tools.bash({
        command,
        workdir: input.workdir,
        description: "List changed repository files",
        timeoutMs: 30000,
      }),
    );
  for (const result of results) {
    if (result.kind !== "foreground" || result.exitCode !== 0)
      throw new Error("Could not list changed files");
    if (result.stdout.truncated || result.stderr.truncated)
      throw new Error("Changed-file inventory was truncated; refusing incomplete validation input");
  }
  const parse = (value) => [...new Set(value.split("\0").filter(Boolean))].sort();
  const branchFiles = parse(results[0].stdout.text);
  const workingTreeFiles = parse(results[1].stdout.text);
  const untrackedFiles = parse(results[2].stdout.text);
  const files = [...new Set([...branchFiles, ...workingTreeFiles, ...untrackedFiles])].sort();
  const totalPathBytes = files.reduce((sum, file) => sum + file.length, 0);
  if (files.length > 5000 || totalPathBytes > 1000000)
    throw new Error("Changed-file inventory exceeds the complete validation bound");
  return { baseRef, files, branchFiles, workingTreeFiles, untrackedFiles };
}
