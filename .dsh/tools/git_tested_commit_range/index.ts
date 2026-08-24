/**
 * Summarize bounded commits and changed files between two tested Git commits in one checkout.
 */
export default async function git_tested_commit_range(input: {
  workdir: string;
  earlierSha: string;
  recentSha: string;
  maximumCommits?: Integer;
  maximumFiles?: Integer;
}): Promise<{
  earlierSha: string;
  recentSha: string;
  ancestor: boolean;
  commits: Array<{ sha: string; subject: string }>;
  changedFiles: string[];
  commitsTruncated: boolean;
  filesTruncated: boolean;
}> {
  const validSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
  if (!validSha(input.earlierSha) || !validSha(input.recentSha))
    throw new Error("commit references must be full hexadecimal Git object IDs");
  const maximumCommits = Math.max(1, Math.min(input.maximumCommits ?? 200, 1000));
  const maximumFiles = Math.max(1, Math.min(input.maximumFiles ?? 500, 2000));
  const result = await tools.bash({
    command: [
      "set -euo pipefail",
      `git cat-file -e '${input.earlierSha}^{commit}'`,
      `git cat-file -e '${input.recentSha}^{commit}'`,
      "printf '%s\\n' __ANCESTOR__",
      `if git merge-base --is-ancestor '${input.earlierSha}' '${input.recentSha}'; then echo yes; else echo no; fi`,
      "printf '%s\\n' __COMMITS__",
      `git log --format='%H%x09%s' --reverse --max-count=${maximumCommits + 1} '${input.earlierSha}..${input.recentSha}'`,
      "printf '%s\\n' __FILES__",
      `git diff --name-only --diff-filter=ACDMRTUXB '${input.earlierSha}..${input.recentSha}' | sed -n '1,${maximumFiles + 1}p'`,
    ].join("; "),
    workdir: input.workdir,
    description: "Summarize tested Git commit range",
    timeoutMs: 120000,
  });
  if (result.kind !== "foreground")
    throw new Error("Git range inspection did not return in the foreground");
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.aborted ||
    result.signal !== null ||
    result.sandbox?.denied
  )
    throw new Error("Git range inspection failed");
  if (result.stdout.truncated || result.stderr.truncated)
    throw new Error("Git range inspection exceeded bounded process output");
  const lines = result.stdout.text.split("\n");
  const ancestorIndex = lines.indexOf("__ANCESTOR__");
  const commitsIndex = lines.indexOf("__COMMITS__");
  const filesIndex = lines.indexOf("__FILES__");
  if (ancestorIndex < 0 || commitsIndex < 0 || filesIndex < 0)
    throw new Error("Git range output is incomplete");
  const commitLines = lines.slice(commitsIndex + 1, filesIndex).filter(Boolean);
  const fileLines = lines.slice(filesIndex + 1).filter(Boolean);
  const commits = commitLines.slice(0, maximumCommits).map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 1) throw new Error("Git range returned an invalid commit record");
    return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
  return {
    earlierSha: input.earlierSha,
    recentSha: input.recentSha,
    ancestor: lines[ancestorIndex + 1] === "yes",
    commits,
    changedFiles: fileLines.slice(0, maximumFiles),
    commitsTruncated: commitLines.length > maximumCommits,
    filesTruncated: fileLines.length > maximumFiles,
  };
}
