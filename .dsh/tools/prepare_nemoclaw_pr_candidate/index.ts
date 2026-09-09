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
    outcome: string;
    reason: string;
    changes: string[];
    relatedIssues?: {
      number: Integer;
      keyword: "Fixes" | "Closes" | "Resolves" | "Refs" | "Relates to" | "Part of";
    }[];
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
    dgxStation?: {
      testedCommit: string;
      scenario: string;
      result: string;
      evidenceUrl: string;
      exceptionReason?: string;
    };
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
    const sensitiveChanged = preflight.inferred.sensitivePaths.length > 0;
    if (
      input.body.sensitivePath?.changed !== undefined &&
      input.body.sensitivePath.changed !== sensitiveChanged
    )
      blockers.push({
        code: "sensitive-path-mismatch",
        message: "Caller-sensitive path state does not match candidate inspection.",
      });
    rendered = await tools.render_nemoclaw_pr_body({
      ...input.body,
      sensitivePath: {
        changed: sensitiveChanged,
        reviewEvidence: input.body.sensitivePath?.reviewEvidence,
      },
      workdir: input.workdir,
      baseRef: (input.remote ?? "origin") + "/" + (input.baseBranch ?? "main"),
    });
    blockers.push(...rendered.blockers.map((message) => ({ code: "pr-body-evidence", message })));
    const docsChanged = preflight.changedFiles.some(
      (path) =>
        path.startsWith("docs/") || path === "fern/docs.yml" || path.startsWith("fern/assets/"),
    );
    if (docsChanged && input.body.docs?.buildPassed !== true)
      blockers.push({
        code: "docs-build-evidence",
        message: "Documentation changes require a passing npm run docs result.",
      });
  } else
    warnings.push({
      code: "body-input-required",
      message: "Typed PR body evidence is required before publication.",
    });
  return {
    preflight,
    validation,
    body: rendered?.body ?? null,
    readyToPublish: blockers.length === 0 && Boolean(rendered),
    blockers,
    warnings,
  };
}
