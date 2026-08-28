/**
 * Render the trusted NemoClaw pull request template from typed evidence without writing to GitHub.
 */
export default async function render_nemoclaw_pr_body(input: {
  workdir: string;
  baseRef?: string;
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
}): Promise<{ body: string; blockers: string[] }> {
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
    if (typeof value !== "string" || !value.trim() || value.length > 4000 || /[\r\n]/.test(value))
      throw new Error(label + " must be one non-empty line of at most 4000 characters");
    return value.trim();
  };
  if (typeof input.workdir !== "string" || !input.workdir.trim())
    throw new Error("workdir is required");
  const outcome = line(input.outcome, "outcome");
  const reason = line(input.reason, "reason");
  if (!Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > 100)
    throw new Error("changes must contain 1 to 100 entries");
  const changes = input.changes.map((value, index) => line(value, "change " + index));
  const template = await tools.bash({
    command: "git show " + quote(baseRef + ":.github/PULL_REQUEST_TEMPLATE.md"),
    workdir: input.workdir,
    description: "Read trusted pull request template",
    timeoutMs: 30000,
  });
  if (template.kind !== "foreground" || template.exitCode !== 0)
    throw new Error("Could not read trusted pull request template");
  const trustedTemplate = template.stdout.text;
  for (const heading of [
    "## Outcome",
    "## Reason",
    "## Changes",
    "## Verification",
    "## Review notes",
  ])
    if (!trustedTemplate.includes(heading))
      throw new Error("Trusted pull request template is missing " + heading);
  const tests = input.tests;
  if (!tests || !["added-or-updated", "existing", "not-applicable"].includes(tests.result))
    throw new Error("tests.result is invalid");
  const blockers = [];
  if (tests.result !== "not-applicable" && !tests.evidence)
    blockers.push("Test evidence is required.");
  if (tests.result !== "added-or-updated" && !tests.justification)
    blockers.push("Test justification is required.");
  if (!input.hooks || input.hooks.passed !== true)
    blockers.push("Hook or validate:pr evidence is required.");
  if (input.noSecrets !== true) blockers.push("No-secrets confirmation is required.");
  if (!input.dco || input.dco.commitsVerified !== true)
    blockers.push("Every commit must appear as Verified.");
  const dcoName = typeof input.dco?.name === "string" ? input.dco.name.trim() : "";
  const dcoEmail = typeof input.dco?.email === "string" ? input.dco.email.trim() : "";
  if (!dcoName) blockers.push("DCO name is required.");
  if (!dcoEmail) blockers.push("DCO email is required.");
  const sensitive = input.sensitivePath ?? { changed: false };
  if (sensitive.changed && !sensitive.reviewEvidence)
    blockers.push("Sensitive-path review evidence or a waiver is required.");
  const keywords = ["Fixes", "Closes", "Resolves", "Refs", "Relates to", "Part of"];
  const relatedIssues = input.relatedIssues ?? [];
  if (!Array.isArray(relatedIssues) || relatedIssues.length > 20)
    throw new Error("relatedIssues must contain at most 20 issues");
  for (const issue of relatedIssues)
    if (
      !Number.isSafeInteger(issue.number) ||
      issue.number < 1 ||
      !keywords.includes(issue.keyword)
    )
      throw new Error("relatedIssues contains an invalid relationship");
  const verification = [];
  const addEvidence = (label, detail) => {
    verification.push("- " + label + ": " + line(detail, label));
  };
  addEvidence(
    "Contributor validation",
    input.hooks?.evidence ?? (input.hooks?.passed ? "Normal hooks passed" : "Missing"),
  );
  if (tests.result === "not-applicable")
    addEvidence(
      "Tests",
      "Not applicable — " + (tests.justification?.trim() || "Missing justification"),
    );
  else addEvidence("Tests", tests.evidence?.trim() || "Missing evidence");
  if (input.broadGate?.passed === true) addEvidence("Broad gate", input.broadGate.evidence);
  if (input.docs?.buildPassed === true) addEvidence("Documentation build", "npm run docs passed");
  if (input.docs?.styleReviewed === true) addEvidence("Documentation style", "Review completed");
  if (input.docs?.newPagesValidated === true)
    addEvidence("New documentation pages", "SPDX headers and frontmatter validated");
  addEvidence("Secrets review", "The diff contains no secrets, API keys, or credentials");
  const reviewNotes = [];
  if (sensitive.changed && sensitive.reviewEvidence)
    reviewNotes.push(
      "- Sensitive-path review: " + line(sensitive.reviewEvidence, "Sensitive-path review"),
    );
  if (input.ciWaiver) {
    if (!Number.isSafeInteger(input.ciWaiver.followUpIssue) || input.ciWaiver.followUpIssue < 1)
      throw new Error("ciWaiver.followUpIssue must be positive");
    reviewNotes.push(
      "- CI exception: " +
        line(input.ciWaiver.check, "CI check") +
        "; approval: " +
        line(input.ciWaiver.approval, "CI approval") +
        "; follow-up: #" +
        input.ciWaiver.followUpIssue,
    );
  }
  if (input.dgxStation) {
    reviewNotes.push(
      "- DGX Station tested commit: " + line(input.dgxStation.testedCommit, "DGX tested commit"),
      "- DGX Station profile or scenario: " + line(input.dgxStation.scenario, "DGX scenario"),
      "- DGX Station result: " + line(input.dgxStation.result, "DGX result"),
      "- DGX Station supporting evidence: " + line(input.dgxStation.evidenceUrl, "DGX evidence"),
    );
    if (input.dgxStation.exceptionReason)
      reviewNotes.push(
        "- DGX Station exception: " + line(input.dgxStation.exceptionReason, "DGX exception"),
      );
  }
  const replaceSection = (body, heading, content, nextHeadingPattern) => {
    const pattern = new RegExp(
      "(^|\\n)(" + heading + ")\\n[\\s\\S]*?(?=\\n" + nextHeadingPattern + "|$)",
      "u",
    );
    if (!pattern.test(body)) throw new Error("Trusted template is missing " + heading);
    return body.replace(
      pattern,
      (_, prefix, title) => prefix + title + "\n\n" + content.trim() + "\n",
    );
  };
  let body = trustedTemplate.replace(/<!--(?! markdownlint-disable MD041)[\s\S]*?-->/gu, "").trim();
  body = replaceSection(body, "## Outcome", outcome, "## Reason");
  let reasonContent = reason;
  if (relatedIssues.length)
    reasonContent +=
      "\n\n### Related issues\n\n" +
      relatedIssues.map((issue) => issue.keyword + " #" + issue.number).join("\n");
  body = replaceSection(body, "## Reason", reasonContent, "## Changes");
  body = replaceSection(
    body,
    "## Changes",
    changes.map((value) => "- " + value).join("\n"),
    "## Verification",
  );
  body = replaceSection(body, "## Verification", verification.join("\n"), "## Review notes|---");
  if (reviewNotes.length)
    body = replaceSection(body, "## Review notes", reviewNotes.join("\n"), "---");
  else body = body.replace(/\n## Review notes\n[\s\S]*?(?=\n---)/u, "");
  body = body.replace(
    /Signed-off-by: [^\n]*/u,
    "Signed-off-by: " +
      (dcoName || "Missing DCO name") +
      " <" +
      (dcoEmail || "missing-dco-email") +
      ">",
  );
  body = body.trim() + "\n";
  if (body.length > 60000) throw new Error("Rendered PR body exceeds 60000 characters");
  return { body, blockers };
}
