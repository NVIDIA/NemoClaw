/**
 * Render a concise Markdown report from a structured two-run E2E investigation.
 */
export default async function e2e_investigation_report(input: {
  repository: string;
  earlier: { id: Integer; headSha: string; url: string };
  recent: { id: Integer; headSha: string; url: string };
  commits: Array<{ sha: string; subject: string }>;
  groups: Array<{
    key: string;
    jobs: Array<{ jobName: string; jobId: Integer }>;
    classification: string;
    matchedChangedFiles: string[];
    evidence: string[];
    confidence: string;
    proven?: string[];
    hypothesis?: string[];
    notVerified?: string[];
    nextSteps?: string[];
  }>;
}): Promise<{ markdown: string }> {
  const lines: string[] = [];
  lines.push("# E2E Run Comparison", "");
  lines.push(`Repository: \`${input.repository}\``);
  lines.push(
    `Earlier: [run ${input.earlier.id}](${input.earlier.url}) at \`${input.earlier.headSha}\``,
  );
  lines.push(
    `Recent: [run ${input.recent.id}](${input.recent.url}) at \`${input.recent.headSha}\``,
  );
  lines.push("", "## Commits between runs", "");
  if (input.commits.length === 0) lines.push("No commits were found between the tested commits.");
  else
    for (const commit of input.commits)
      lines.push(`- \`${commit.sha.slice(0, 12)}\` ${commit.subject}`);
  lines.push("", "## Root-cause groups", "");
  for (const group of input.groups) {
    lines.push(`### ${group.key}`, "");
    lines.push(`- Classification: \`${group.classification}\``);
    lines.push(`- Confidence: \`${group.confidence}\``);
    lines.push(`- Jobs: ${group.jobs.map((job) => `${job.jobName} (${job.jobId})`).join(", ")}`);
    lines.push(
      `- Changed files matched: ${group.matchedChangedFiles.length === 0 ? "none" : group.matchedChangedFiles.map((file) => `\`${file}\``).join(", ")}`,
    );
    if (group.proven?.length)
      lines.push("", "**Proven**", ...group.proven.map((item) => `- ${item}`));
    if (group.hypothesis?.length)
      lines.push("", "**Supported hypothesis**", ...group.hypothesis.map((item) => `- ${item}`));
    if (group.notVerified?.length)
      lines.push("", "**Not yet verified**", ...group.notVerified.map((item) => `- ${item}`));
    if (group.evidence.length)
      lines.push("", "**Evidence excerpts**", "```text", ...group.evidence.slice(0, 12), "```");
    if (group.nextSteps?.length)
      lines.push("", "**Next steps**", ...group.nextSteps.map((item) => `- ${item}`));
    lines.push("");
  }
  return { markdown: lines.join("\n") };
}
