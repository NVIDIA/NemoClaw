/**
 * Group E2E failures by stable signature and correlate them with changed files.
 */
export default async function e2e_root_cause_correlator(input: {
  failures: Array<{
    jobName: string;
    jobId: Integer;
    signatureLines: string[];
    relevantPaths?: string[];
  }>;
  changedFiles: string[];
}): Promise<{
  groups: Array<{
    key: string;
    jobs: Array<{ jobName: string; jobId: Integer }>;
    classification:
      | "source-change-candidate"
      | "no-relevant-source-change"
      | "external-or-transient-candidate";
    matchedChangedFiles: string[];
    evidence: string[];
    confidence: "high" | "medium" | "low";
  }>;
}> {
  if (!Array.isArray(input.failures) || input.failures.length > 100)
    throw new Error("failures must contain at most 100 items");
  if (!Array.isArray(input.changedFiles) || input.changedFiles.length > 2000)
    throw new Error("changedFiles must contain at most 2000 items");
  let inputCharacters = 0;
  let relevantPathCount = 0;
  for (const file of input.changedFiles) {
    if (typeof file !== "string" || file.length === 0 || file.length > 1000 || /[\r\n]/u.test(file))
      throw new Error("changedFiles must contain bounded single-line paths");
    inputCharacters += file.length;
  }
  for (const failure of input.failures) {
    if (
      !failure ||
      typeof failure.jobName !== "string" ||
      failure.jobName.length === 0 ||
      failure.jobName.length > 500 ||
      /[\r\n]/u.test(failure.jobName) ||
      !Number.isSafeInteger(failure.jobId) ||
      failure.jobId < 1
    )
      throw new Error("failures must contain bounded job identities");
    if (!Array.isArray(failure.signatureLines) || failure.signatureLines.length > 300)
      throw new Error("signatureLines must contain at most 300 items");
    if (failure.relevantPaths !== undefined && !Array.isArray(failure.relevantPaths))
      throw new Error("relevantPaths must be an array");
    const relevantPaths = failure.relevantPaths ?? [];
    if (relevantPaths.length > 100) throw new Error("relevantPaths must contain at most 100 items");
    relevantPathCount += relevantPaths.length;
    inputCharacters += failure.jobName.length;
    for (const line of failure.signatureLines) {
      if (typeof line !== "string" || line.length > 4000 || /[\r\n]/u.test(line))
        throw new Error("signatureLines must contain bounded single-line strings");
      inputCharacters += line.length;
    }
    for (const path of relevantPaths) {
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        path.length > 1000 ||
        /[\r\n]/u.test(path)
      )
        throw new Error("relevantPaths must contain bounded single-line paths");
      inputCharacters += path.length;
    }
  }
  if (relevantPathCount > 2000) throw new Error("relevantPaths exceed the total item bound");
  if (inputCharacters > 400000) throw new Error("correlation input exceeds 400000 code units");
  const signatureKey = (lines: string[]) => {
    const text = lines.join(" ").toLowerCase();
    if (text.includes("failedstage=publication") || text.includes("launch-readiness evidence"))
      return "launch-readiness/publication/evidence-failed";
    if (text.includes("sandbox_phase=deleting") || text.includes("sandbox in deleting"))
      return "openshell/lifecycle/sandbox-deleting";
    if (
      text.includes("reviewed npm audit") ||
      text.includes("unaccepted at or above high") ||
      text.includes("advisory")
    )
      return "dependency-audit/unaccepted-advisory";
    if (text.includes("timed out") || text.includes("timeout"))
      return "runtime/timeout/unclassified";
    const first =
      lines.find((line) => /error|failed|failure/i.test(line)) ?? "unclassified failure";
    return first
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/[a-f0-9]{40}/gi, "<sha>")
      .replace(/\d+/g, "<n>")
      .slice(0, 120)
      .toLowerCase();
  };
  const byKey = new Map<string, any[]>();
  for (const failure of input.failures) {
    const key = signatureKey(failure.signatureLines);
    const group = byKey.get(key) ?? [];
    group.push(failure);
    byKey.set(key, group);
  }
  const groups: any[] = [];
  for (const [key, failures] of byKey) {
    const relevant = new Set<string>();
    for (const failure of failures)
      for (const path of failure.relevantPaths ?? []) relevant.add(path);
    const relevantPaths = [...relevant];
    const matched = input.changedFiles.filter((file) =>
      relevantPaths.some(
        (path) => file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`),
      ),
    );
    const externalSignature = key.includes("dependency-audit") || key.includes("sandbox-deleting");
    const classification =
      matched.length > 0
        ? "source-change-candidate"
        : externalSignature
          ? "external-or-transient-candidate"
          : "no-relevant-source-change";
    groups.push({
      key,
      jobs: failures.map((failure) => ({ jobName: failure.jobName, jobId: failure.jobId })),
      classification,
      matchedChangedFiles: matched,
      evidence: failures.flatMap((failure) => failure.signatureLines.slice(0, 8)).slice(0, 24),
      confidence:
        matched.length > 0 || failures.length > 1 ? "high" : relevant.size > 0 ? "medium" : "low",
    });
  }
  const output = { groups };
  if (JSON.stringify(output).length > 400000)
    throw new Error("correlation output exceeds 400000 code units");
  return output;
}
