/**
 * Compose candidate inspection, validation inference, and optional typed PR body rendering without publishing.
 */
export default async function prepare_nemoclaw_pr_candidate(input: {
  workdir: string;
  repository?: string;
  remote?: string;
  baseBranch?: string;
  refreshBase?: boolean;
  apply?: boolean;
  body?: {
    summary: string;
    changes: string[];
    relatedIssue?: { number: Integer; keyword: "Fixes" | "Closes" };
    typeOfChange: "code" | "code-with-docs" | "docs-prose" | "docs-code-samples";
    tests: {
      result: "added-or-updated" | "existing" | "not-applicable";
      evidence?: string;
      justification?: string;
    };
    sensitivePath?: { changed: boolean; reviewEvidence?: string };
    ciWaiver?: { check: string; approval: string; followUpIssue: Integer };
    hooks: { passed: boolean; evidence?: string };
    broadGate?: { passed: boolean; evidence: string };
    docs?: { buildPassed?: boolean; styleReviewed?: boolean; newPagesValidated?: boolean };
    dgxStation?: { testedCommit: string; scenario: string; result: string; evidenceUrl: string };
    dco: { commitsVerified: boolean; name: string; email: string };
    noSecrets: boolean;
  };
}): Promise<{
  preflight: {
    repository: string;
    remote: string;
    baseBranch: string;
    baseSha: string;
    branch: string;
    headSha: string;
    clean: boolean | null;
    commits: {
      sha: string;
      subject: string;
      signedOffBy: boolean;
      githubVerification: string;
      verificationReason: string | null;
    }[];
    changedFiles: string[];
    aheadCount: Integer;
    permissions: { viewerPermission: string; canAssignSelf: boolean };
    existingPullRequest: { number: Integer; state: string; url: string } | null;
    inferred: {
      issueNumbers: Integer[];
      typeOfChange: string;
      sensitivePaths: string[];
      dgxStationEvidenceRequired: boolean;
    };
    blockers: { code: string; message: string }[];
    warnings: { code: string; message: string }[];
  };
  validation: {
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
  body: string | null;
  templateSha: string | null;
  readyToPublish: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}> {
  const preflight = await tools.inspect_nemoclaw_pr_candidate({
    workdir: input.workdir,
    ...(input.repository ? { repository: input.repository } : {}),
    ...(input.remote ? { remote: input.remote } : {}),
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    refreshBase: input.refreshBase ?? false,
    ...(input.refreshBase ? { apply: input.apply === true } : {}),
  });
  const validation = await tools.infer_validation_for_changed_files({
    workdir: input.workdir,
    baseRef: (input.remote ?? "origin") + "/" + (input.baseBranch ?? "main"),
  });
  const blockers = [...preflight.blockers],
    warnings = [...preflight.warnings];
  let rendered = null;
  if (input.body) {
    rendered = await tools.render_nemoclaw_pr_body({
      ...input.body,
      workdir: input.workdir,
      baseRef: (input.remote ?? "origin") + "/" + (input.baseBranch ?? "main"),
    });
    blockers.push(...rendered.blockers);
    warnings.push(...rendered.warnings);
  } else
    warnings.push({
      code: "body-input-required",
      message: "Typed PR body evidence is required before publication.",
    });
  return {
    preflight,
    validation,
    body: rendered?.body ?? null,
    templateSha: rendered?.templateSha ?? null,
    readyToPublish: blockers.length === 0 && Boolean(rendered),
    blockers,
    warnings,
  };
}
