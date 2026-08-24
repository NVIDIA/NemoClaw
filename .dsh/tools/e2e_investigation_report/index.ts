/**
 * Render a bounded Markdown report from a structured two-run E2E investigation.
 */
export default async function e2e_investigation_report(input: {
  repository: string;
  earlier: { id: Integer; headSha: string; url: string };
  recent: { id: Integer; headSha: string; url: string };
  range: { ancestor: boolean; commitsTruncated: boolean; filesTruncated: boolean };
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
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository))
    throw new Error("repository must have owner/name form");
  if (
    !input.range ||
    typeof input.range.ancestor !== "boolean" ||
    typeof input.range.commitsTruncated !== "boolean" ||
    typeof input.range.filesTruncated !== "boolean"
  )
    throw new Error("range must contain ancestry and truncation state");
  if (!Array.isArray(input.commits) || input.commits.length > 1000)
    throw new Error("commits must contain at most 1000 items");
  if (!Array.isArray(input.groups) || input.groups.length > 100)
    throw new Error("groups must contain at most 100 items");
  let inputCharacters = input.repository.length;
  const validateLine = (value: unknown, maximum: number, field: string) => {
    if (typeof value !== "string" || value.length > maximum || /[\r\n]/u.test(value))
      throw new Error(`${field} must be a bounded single-line string`);
    inputCharacters += value.length;
  };
  const validateRun = (run: typeof input.earlier, field: string) => {
    if (
      !run ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      typeof run.headSha !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(run.headSha) ||
      typeof run.url !== "string" ||
      run.url.length > 2000
    )
      throw new Error(`${field} must contain a bounded GitHub Actions run`);
    let url: URL;
    try {
      url = new URL(run.url);
    } catch {
      throw new Error(`${field}.url must be a valid URL`);
    }
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.pathname !== `/${input.repository}/actions/runs/${run.id}` ||
      url.search ||
      url.hash ||
      run.url !== `${url.origin}${url.pathname}`
    )
      throw new Error(`${field}.url must identify the supplied GitHub Actions run`);
    inputCharacters += run.headSha.length + run.url.length;
  };
  validateRun(input.earlier, "earlier");
  validateRun(input.recent, "recent");
  for (const commit of input.commits) {
    if (
      !commit ||
      typeof commit.sha !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit.sha)
    )
      throw new Error("commits must contain full hexadecimal commit SHAs");
    validateLine(commit.subject, 1000, "commit subject");
    inputCharacters += commit.sha.length;
  }
  for (const group of input.groups) {
    if (!group || typeof group !== "object") throw new Error("groups must contain objects");
    validateLine(group.key, 500, "group key");
    validateLine(group.classification, 100, "group classification");
    validateLine(group.confidence, 100, "group confidence");
    if (!Array.isArray(group.jobs) || group.jobs.length > 100)
      throw new Error("group jobs must contain at most 100 items");
    if (!Array.isArray(group.matchedChangedFiles) || group.matchedChangedFiles.length > 2000)
      throw new Error("matchedChangedFiles must contain at most 2000 items");
    if (!Array.isArray(group.evidence) || group.evidence.length > 24)
      throw new Error("group evidence must contain at most 24 items");
    for (const job of group.jobs) {
      if (!job || !Number.isSafeInteger(job.jobId) || job.jobId < 1)
        throw new Error("group jobs must contain positive job IDs");
      validateLine(job.jobName, 500, "job name");
    }
    for (const file of group.matchedChangedFiles) validateLine(file, 1000, "matched changed file");
    for (const evidence of group.evidence) validateLine(evidence, 4000, "evidence line");
    const sections: Array<[string, string[] | undefined]> = [
      ["proven", group.proven],
      ["hypothesis", group.hypothesis],
      ["notVerified", group.notVerified],
      ["nextSteps", group.nextSteps],
    ];
    for (const [field, items] of sections) {
      if (items !== undefined && (!Array.isArray(items) || items.length > 100))
        throw new Error(`${field} must contain at most 100 items`);
      for (const item of items ?? []) validateLine(item, 2000, field);
    }
  }
  if (inputCharacters > 400000) throw new Error("report input exceeds 400000 code units");
  const markdownText = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replace(/([\\`*_{}\[\]()+#\-.!|~])/gu, "\\$1");
  const inlineCode = (value: string) => {
    const longest = Math.max(0, ...(value.match(/`+/gu) ?? []).map((item) => item.length));
    const delimiter = "`".repeat(longest + 1);
    const content = value.startsWith("`") || value.endsWith("`") ? ` ${value} ` : value;
    return `${delimiter}${content}${delimiter}`;
  };
  const lines: string[] = [];
  lines.push("# E2E Run Comparison", "");
  lines.push(`Repository: ${inlineCode(input.repository)}`);
  lines.push(
    `Earlier: [run ${input.earlier.id}](${input.earlier.url}) at ${inlineCode(input.earlier.headSha)}`,
  );
  lines.push(
    `Recent: [run ${input.recent.id}](${input.recent.url}) at ${inlineCode(input.recent.headSha)}`,
  );
  lines.push("", "## Investigation Status", "");
  const limitations = [
    ...(!input.range.ancestor
      ? ["The earlier tested commit is not an ancestor of the recent tested commit."]
      : []),
    ...(input.range.commitsTruncated ? ["The commit list is truncated."] : []),
    ...(input.range.filesTruncated ? ["The changed-file list is truncated."] : []),
  ];
  if (limitations.length === 0) lines.push("The tested commit range is complete.");
  else lines.push("The investigation is incomplete.", ...limitations.map((item) => `- ${item}`));
  lines.push("", "## Commits Between Runs", "");
  if (input.commits.length === 0) lines.push("No commits were found between the tested commits.");
  else
    for (const commit of input.commits)
      lines.push(`- ${inlineCode(commit.sha.slice(0, 12))} ${markdownText(commit.subject)}`);
  lines.push("", "## Root-Cause Groups", "");
  for (const group of input.groups) {
    lines.push(`### ${markdownText(group.key)}`, "");
    lines.push(`- Classification: ${inlineCode(group.classification)}`);
    lines.push(`- Confidence: ${inlineCode(group.confidence)}`);
    lines.push(
      `- Jobs: ${group.jobs.map((job) => `${markdownText(job.jobName)} (${job.jobId})`).join(", ")}`,
    );
    lines.push(
      `- Changed files matched: ${group.matchedChangedFiles.length === 0 ? "none" : group.matchedChangedFiles.map(inlineCode).join(", ")}`,
    );
    if (group.proven?.length)
      lines.push("", "**Proven**", ...group.proven.map((item) => `- ${markdownText(item)}`));
    if (group.hypothesis?.length)
      lines.push(
        "",
        "**Supported hypothesis**",
        ...group.hypothesis.map((item) => `- ${markdownText(item)}`),
      );
    if (group.notVerified?.length)
      lines.push(
        "",
        "**Not yet verified**",
        ...group.notVerified.map((item) => `- ${markdownText(item)}`),
      );
    if (group.evidence.length) {
      const longest = Math.max(
        0,
        ...group.evidence.flatMap((item) => (item.match(/`+/gu) ?? []).map((run) => run.length)),
      );
      const fence = "`".repeat(Math.max(3, longest + 1));
      lines.push("", "**Evidence excerpts**", `${fence}text`, ...group.evidence, fence);
    }
    if (group.nextSteps?.length)
      lines.push("", "**Next steps**", ...group.nextSteps.map((item) => `- ${markdownText(item)}`));
    lines.push("");
  }
  const markdown = lines.join("\n");
  if (markdown.length > 400000) throw new Error("report output exceeds 400000 code units");
  return { markdown };
}
