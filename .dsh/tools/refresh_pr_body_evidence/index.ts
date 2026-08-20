// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const repo = input.repo ?? "NVIDIA/NemoClaw";
const headWaitMs = input.headWaitMs ?? 30000;
if (!Number.isSafeInteger(input.number) || input.number <= 0)
  throw new Error("refresh_pr_body_evidence requires a positive PR number");
if (typeof input.workdir !== "string" || !input.workdir.trim() || input.workdir.length > 4096)
  throw new Error("workdir must contain 1 to 4096 characters");
if (
  typeof repo !== "string" ||
  repo.length > 255 ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
)
  throw new Error("repo must be owner/name with at most 255 characters");
if (!Number.isSafeInteger(headWaitMs) || headWaitMs < 0 || headWaitMs > 120000)
  throw new Error("headWaitMs must be an integer from 0 through 120000");
if (!input.docsReceipt && !input.targetedValidationLine && !input.broadGate)
  throw new Error("refresh_pr_body_evidence requires at least one evidence update");
if (input.apply && !input.expectedHeadSha)
  throw new Error("expectedHeadSha is required when apply is true");
if (input.expectedHeadSha && !/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
  throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
const oneLine = (label, value) => {
  if (typeof value !== "string" || value.length > 4000 || !value.trim() || /[\r\n]/.test(value))
    throw new Error(label + " must be a non-empty single line of at most 4000 characters");
  return value.trim();
};
if (input.docsReceipt) {
  oneLine("Documentation evidence", input.docsReceipt.evidence);
  oneLine("Documentation agent", input.docsReceipt.agent);
}
if (input.targetedValidationLine)
  oneLine("Targeted validation evidence", input.targetedValidationLine);
if (input.broadGate) oneLine("Broad gate evidence", input.broadGate.evidence);
const accessFailure =
  /authentication|authorization|forbidden|not authorized|HTTP 40[13]|resource not accessible|SSO/i;
const run = async (command, description) => {
  const result = await tools.bash({
    command,
    workdir: input.workdir,
    description,
    timeoutMs: 30000,
  });
  if (result.kind !== "foreground") throw new Error(description + " did not finish");
  const detail = result.stdout.text + "\n" + result.stderr.text;
  if (result.exitCode !== 0) {
    if (accessFailure.test(detail))
      throw new Error(
        "GitHub access failed; correct authentication or authorization before retrying.\n" +
          detail.trim(),
      );
    throw new Error(description + " failed.\n" + detail.trim());
  }
  if (result.stdout.truncated) throw new Error(description + " exceeded the bounded read");
  return result.stdout.text.trim();
};
const localHead = await run("git rev-parse HEAD", "Resolve checkout commit");
const agentsBlob = await run("git rev-parse HEAD:AGENTS.md", "Resolve AGENTS.md blob");
const shaPattern = /^[0-9a-f]{40,64}$/;
if (!shaPattern.test(localHead) || !shaPattern.test(agentsBlob))
  throw new Error("Could not resolve valid local commit and AGENTS.md blob SHAs");
if (input.expectedHeadSha && localHead !== input.expectedHeadSha)
  throw new Error(
    "Checkout commit changed: expected " + input.expectedHeadSha + ", found " + localHead,
  );
const readPr = async () =>
  JSON.parse(
    await run(
      "gh api " +
        quote("repos/" + repo + "/pulls/" + input.number) +
        " --jq " +
        quote('{state,headSha:.head.sha,body:(.body//""),updatedAt:.updated_at}'),
      "Read pull request evidence",
    ),
  );
const startedAt = Date.now();
let polls = 0;
let pr;
while (true) {
  polls += 1;
  pr = await readPr();
  if (!shaPattern.test(String(pr.headSha ?? "")))
    throw new Error("Could not resolve a valid PR commit SHA");
  if (pr.headSha === localHead) break;
  if (pr.state !== "open")
    throw new Error(
      "PR " +
        input.number +
        " state is " +
        pr.state +
        "; its commit " +
        pr.headSha +
        " does not match checkout commit " +
        localHead,
    );
  if (Date.now() - startedAt >= headWaitMs)
    throw new Error(
      "PR " +
        input.number +
        " commit remained " +
        pr.headSha +
        " after " +
        headWaitMs +
        " ms; checkout commit is " +
        localHead,
    );
  const delay = Math.min(1000, Math.max(100, headWaitMs));
  await run("sleep " + quote(String(delay / 1000)), "Wait for pull request commit");
}
const renderBody = (initialBody) => {
  let body = initialBody;
  if (input.docsReceipt) {
    const replacement =
      "- [x] Documentation writer subagent reviewed the completed changes\n- Result: \x60" +
      input.docsReceipt.result +
      "\x60\n- Evidence: " +
      input.docsReceipt.evidence.trim() +
      "\n- Agent: " +
      input.docsReceipt.agent.trim() +
      "\n<!-- docs-review-head-sha: " +
      localHead +
      " -->\n<!-- docs-review-agents-blob-sha: " +
      agentsBlob +
      " -->";
    const pattern =
      /- \[[ xX]\] Documentation writer subagent reviewed the completed changes\n- Result: `[^`]+`\n- Evidence: [^\n]*\n- Agent: [^\n]*\n<!-- docs-review-head-sha: [^>]+ -->\n<!-- docs-review-agents-blob-sha: [^>]+ -->/;
    if (!pattern.test(body))
      throw new Error("Could not find Documentation Writer Review receipt block");
    body = body.replace(pattern, replacement);
  }
  if (input.targetedValidationLine) {
    const pattern =
      /- \[[ xX]\] Targeted behavior tests pass for the current change set, or tests are marked not applicable above — [^\n]*/;
    if (!pattern.test(body)) throw new Error("Could not find targeted validation line");
    body = body.replace(
      pattern,
      "- [x] Targeted behavior tests pass for the current change set, or tests are marked not applicable above — " +
        input.targetedValidationLine.trim(),
    );
  }
  if (input.broadGate) {
    const pattern = /- \[[ xX]\] Applicable broad gate passed[^\n]*/;
    if (!pattern.test(body)) throw new Error("Could not find broad gate line");
    body = body.replace(
      pattern,
      "- [" +
        (input.broadGate.passed ? "x" : " ") +
        "] Applicable broad gate passed — " +
        input.broadGate.evidence.trim(),
    );
  }
  return body;
};
const previewBody = renderBody(String(pr.body ?? ""));
const waitedMs = Date.now() - startedAt;
if (!input.apply)
  return {
    ok: true,
    apply: false,
    mutated: false,
    wouldUpdate: pr.state === "open" && previewBody !== pr.body,
    number: input.number,
    repo,
    workdir: input.workdir,
    prState: pr.state,
    headSha: localHead,
    agentsBlob,
    bodyChanged: previewBody !== pr.body,
    polls,
    waitedMs,
  };
if (pr.state !== "open")
  throw new Error(
    "PR " + input.number + " state is " + pr.state + "; evidence writes require an open PR",
  );
const finalPr = await readPr();
if (finalPr.state !== "open")
  throw new Error(
    "PR " + input.number + " state changed to " + finalPr.state + "; evidence write stopped",
  );
if (finalPr.headSha !== localHead)
  throw new Error(
    "PR " + input.number + " commit changed to " + finalPr.headSha + "; expected " + localHead,
  );
const body = renderBody(String(finalPr.body ?? ""));
const updated = JSON.parse(
  await run(
    "gh api " +
      quote("repos/" + repo + "/pulls/" + input.number) +
      " -X PATCH -f " +
      quote("body=" + body),
    "Update pull request evidence",
  ),
);
return {
  ok: true,
  apply: true,
  mutated: true,
  number: input.number,
  repo,
  workdir: input.workdir,
  headSha: localHead,
  agentsBlob,
  polls,
  waitedMs,
  updatedAt: updated.updated_at ?? null,
};
