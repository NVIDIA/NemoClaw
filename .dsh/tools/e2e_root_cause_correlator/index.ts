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
    const matched = input.changedFiles.filter((file) =>
      [...relevant].some(
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
  return { groups };
}
