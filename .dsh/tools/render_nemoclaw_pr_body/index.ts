/**
 * Render the trusted NemoClaw pull request template from typed evidence without writing to GitHub.
 */
export default async function render_nemoclaw_pr_body(input: {
  workdir: string;
  baseRef?: string;
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
}): Promise<{
  body: string;
  templateSha: string;
  selectedChecks: string[];
  blockers: string[];
  warnings: string[];
}> {
  const rejectControlCharacters = (value) => {
    if (typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value))
      throw new Error("PR body inputs must not contain control characters");
    if (Array.isArray(value)) value.forEach(rejectControlCharacters);
    else if (value && typeof value === "object")
      Object.values(value).forEach(rejectControlCharacters);
  };
  rejectControlCharacters(input);
  const baseRef = input.baseRef ?? "origin/main";
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  if (
    typeof baseRef !== "string" ||
    !baseRef.trim() ||
    baseRef.length > 255 ||
    baseRef.startsWith("-") ||
    !/^[A-Za-z0-9_./@^~+-]+$/.test(baseRef)
  )
    throw new Error("baseRef must be a valid Git revision");
  const line = (value, label) => {
    if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))
      throw new Error(label + " must be one non-empty line");
    return value.trim();
  };
  if (typeof input.workdir !== "string" || !input.workdir.trim())
    throw new Error("workdir is required");
  const summary = line(input.summary, "summary");
  if (!Array.isArray(input.changes) || input.changes.length === 0)
    throw new Error("changes must not be empty");
  const changes = input.changes.map((value, index) => line(value, "change " + index));
  const template = await tools.bash({
    command: "git show " + quote(baseRef + ":.github/PULL_REQUEST_TEMPLATE.md"),
    workdir: input.workdir,
    description: "Read trusted pull request template",
    timeoutMs: 30000,
  });
  if (template.kind !== "foreground" || template.exitCode !== 0)
    throw new Error("Could not read trusted pull request template");
  const tree = await tools.bash({
    command: "git rev-parse --verify " + quote(baseRef + "^{tree}"),
    workdir: input.workdir,
    description: "Resolve trusted template tree",
    timeoutMs: 10000,
  });
  if (tree.kind !== "foreground" || tree.exitCode !== 0)
    throw new Error("Could not resolve trusted template tree");
  const types = {
    code: "Code change (feature, bug fix, or refactor)",
    "code-with-docs": "Code change with doc updates",
    "docs-prose": "Doc only (prose changes, no code sample modifications)",
    "docs-code-samples": "Doc only (includes code sample changes)",
  };
  if (!types[input.typeOfChange]) throw new Error("Unsupported typeOfChange");
  const tests = input.tests;
  if (!tests || !["added-or-updated", "existing", "not-applicable"].includes(tests.result))
    throw new Error("tests.result is invalid");
  const blockers = [],
    warnings = [],
    selected = [];
  if (tests.result !== "not-applicable" && !tests.evidence)
    blockers.push("Test evidence is required.");
  if (tests.result !== "added-or-updated" && !tests.justification)
    blockers.push("Test justification is required.");
  const sensitive = input.sensitivePath ?? { changed: false };
  if (sensitive.changed && !sensitive.reviewEvidence)
    blockers.push("Sensitive-path review evidence or a waiver is required.");
  if (input.dco.commitsVerified !== true) blockers.push("Every commit must appear as Verified.");
  const check = (label, on, detail) => {
    if (on) selected.push(label);
    return "- [" + (on ? "x" : " ") + "] " + label + (detail ? " " + detail : "");
  };
  const out = ["<!-- markdownlint-disable MD041 -->", "## Summary", "", summary, ""];
  if (input.relatedIssue) {
    if (
      !Number.isSafeInteger(input.relatedIssue.number) ||
      input.relatedIssue.number < 1 ||
      !["Fixes", "Closes"].includes(input.relatedIssue.keyword)
    )
      throw new Error("relatedIssue is invalid");
    out.push(
      "## Related Issue",
      "",
      input.relatedIssue.keyword + " #" + input.relatedIssue.number,
      "",
    );
  }
  out.push(
    "## Changes",
    "",
    ...changes.map((value) => "- " + value),
    "",
    "## Type of Change",
    "",
    check(types.code, input.typeOfChange === "code"),
    check(types["code-with-docs"], input.typeOfChange === "code-with-docs"),
    check(types["docs-prose"], input.typeOfChange === "docs-prose"),
    check(types["docs-code-samples"], input.typeOfChange === "docs-code-samples"),
    "",
    "## Quality Gates",
    "",
    check("Tests added or updated for changed behavior", tests.result === "added-or-updated"),
    check(
      "Existing tests cover changed behavior — justification:",
      tests.result === "existing",
      tests.justification,
    ),
    check(
      "Tests not applicable — justification:",
      tests.result === "not-applicable",
      tests.justification,
    ),
    check(
      "Sensitive paths changed (security, policy, credentials, preflight, onboarding, inference, runner, sandbox, or messaging)",
      sensitive.changed,
    ),
    check(
      "Sensitive-path review completed or maintainer-approved waiver recorded — reviewer/approval link/justification:",
      sensitive.changed && Boolean(sensitive.reviewEvidence),
      sensitive.reviewEvidence,
    ),
    check(
      "Non-success, skipped, or missing CI check accepted by maintainer — check name, approval link, and follow-up issue:",
      Boolean(input.ciWaiver),
      input.ciWaiver
        ? input.ciWaiver.check +
            "; " +
            input.ciWaiver.approval +
            "; #" +
            input.ciWaiver.followUpIssue
        : undefined,
    ),
    "",
    "## DGX Station Hardware Evidence",
    "",
    check("Tested on DGX Station", Boolean(input.dgxStation)),
    "- Tested commit: " + (input.dgxStation?.testedCommit ?? ""),
    "- Station profile/scenario: " + (input.dgxStation?.scenario ?? ""),
    "- Result: " + (input.dgxStation?.result ?? ""),
    "- Supporting evidence: " + (input.dgxStation?.evidenceUrl ?? ""),
    "",
    "## Verification",
    "",
    check(
      "PR description includes a `Signed-off-by:` line and every commit appears as `Verified` in GitHub",
      input.dco.commitsVerified === true,
    ),
    check(
      "Normal `pre-commit`, `commit-msg`, and `pre-push` hooks passed, or `npm run validate:pr` passed after refreshing `origin/main` when hooks were skipped or unavailable",
      input.hooks.passed === true,
      input.hooks.evidence ? "— " + input.hooks.evidence : undefined,
    ),
    check(
      "Targeted behavior tests pass for the current change set, or tests are marked not applicable above — command/result or justification:",
      tests.result === "not-applicable" || Boolean(tests.evidence),
      tests.evidence,
    ),
    check(
      "Applicable broad gate passed — `npm test` for broad runtime/test-harness changes; `npm run check` for repo-wide validation/coverage changes — command/result:",
      input.broadGate?.passed === true,
      input.broadGate?.evidence,
    ),
    check(
      "Quality Gates section completed with required justifications or waivers",
      blockers.length === 0,
    ),
    check("No secrets, API keys, or credentials committed", input.noSecrets === true),
    check(
      "`npm run docs` builds without warnings (doc changes only)",
      input.docs?.buildPassed === true,
    ),
    check(
      "Doc pages follow the style guide (doc changes only)",
      input.docs?.styleReviewed === true,
    ),
    check(
      "New doc pages include SPDX header and frontmatter (new pages only)",
      input.docs?.newPagesValidated === true,
    ),
    "",
    "---",
    "Signed-off-by: " +
      line(input.dco.name, "DCO name") +
      " <" +
      line(input.dco.email, "DCO email") +
      ">",
    "",
  );
  return {
    body: out.join("\n"),
    templateSha: tree.stdout.text.trim(),
    selectedChecks: selected,
    blockers,
    warnings,
  };
}
