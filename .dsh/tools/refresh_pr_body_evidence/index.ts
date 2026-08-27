/**
 * Refresh pull request evidence only when the selected checkout commit exactly matches the open pull request commit.
 */
export default async function refresh_pr_body_evidence(input: {
  number: Integer;
  repo?: string;
  docsReceipt?: {
    result: "blocked" | "docs-updated" | "no-docs-needed";
    evidence: string;
    agent: string;
  };
  targetedValidationLine?: string;
  broadGate?: { passed: boolean; evidence: string };
  headWaitMs?: Integer;
  workdir: string;
  expectedHeadSha?: string;
  apply: boolean;
}): Promise<{
  ok: boolean;
  apply: boolean;
  mutated: boolean;
  wouldUpdate: boolean;
  number: Integer;
  repo: string;
  prState: string;
  headSha: string;
  agentsBlob: string;
  bodyChanged: boolean;
  polls: Integer;
  waitedMs: Integer;
  updatedAt: string | null;
}> {
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
    if (!["blocked", "docs-updated", "no-docs-needed"].includes(input.docsReceipt.result))
      throw new Error("docsReceipt.result is invalid");
    oneLine("Documentation evidence", input.docsReceipt.evidence);
    oneLine("Documentation agent", input.docsReceipt.agent);
  }
  if (input.targetedValidationLine)
    oneLine("Targeted validation evidence", input.targetedValidationLine);
  if (input.broadGate) oneLine("Broad gate evidence", input.broadGate.evidence);
  const accessFailure =
    /authentication|authorization|forbidden|not authorized|HTTP 40[13]|resource not accessible|SSO/i;
  const diagnostic = async (lines, sourceTruncated = false) =>
    (
      await tools.project_diagnostic_text({
        lines,
        maxLines: 20,
        maxCharacters: 4000,
        sourceTruncated,
      })
    ).text;
  const run = async (command, description) => {
    const result = await tools.bash({
      command,
      workdir: input.workdir,
      description,
      timeoutMs: 30000,
    });
    if (result.kind !== "foreground") throw new Error(description + " did not finish");
    const rawDetail = result.stderr.text || result.stdout.text;
    if (result.exitCode !== 0) {
      const detail = await diagnostic(
        rawDetail.split(/\r?\n/),
        result.stderr.truncated || result.stdout.truncated,
      );
      if (accessFailure.test(rawDetail))
        throw new Error(
          "GitHub access failed; correct authentication or authorization before retrying." +
            (detail ? "\n" + detail : ""),
        );
      throw new Error(detail || description + " failed");
    }
    if (result.stdout.truncated) throw new Error(description + " exceeded the bounded read");
    return result.stdout.text.trim();
  };
  const github = async (options) => {
    try {
      return await tools.run_github_cli(options);
    } catch (error) {
      const detail = await diagnostic([String(error?.message ?? error)]);
      throw new Error(detail || "GitHub operation failed");
    }
  };
  const checkout = await tools.read_git_checkout({
    workdir: input.workdir,
    includeRoot: false,
    includeBranch: false,
    includeStatus: false,
  });
  const localHead = checkout.head;
  const agentsBlob = await run("git rev-parse HEAD:AGENTS.md", "Resolve AGENTS.md blob");
  const shaPattern = /^[0-9a-f]{40,64}$/;
  if (!shaPattern.test(agentsBlob)) throw new Error("Could not resolve a valid AGENTS.md blob SHA");
  if (input.expectedHeadSha && localHead !== input.expectedHeadSha)
    throw new Error(
      "Checkout commit changed: expected " + input.expectedHeadSha + ", found " + localHead,
    );
  const readPr = async () => {
    let pr;
    let detailResult;
    try {
      [pr, detailResult] = await Promise.all([
        tools.read_nemoclaw_pr({
          workdir: input.workdir,
          number: input.number,
          repository: repo,
        }),
        github({
          workdir: input.workdir,
          args: ["api", "repos/" + repo + "/pulls/" + input.number],
          timeoutMs: 30000,
        }),
      ]);
    } catch (error) {
      const detail = await diagnostic([String(error?.message ?? error)]);
      throw new Error(detail || "Could not read pull request");
    }
    const detail = JSON.parse(detailResult.stdout);
    return {
      state: String(pr.state).toLowerCase(),
      headSha: pr.headRefOid,
      body: detail.body ?? "",
      updatedAt: detail.updated_at ?? null,
    };
  };
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
      if (pattern.test(body)) body = body.replace(pattern, replacement);
      else {
        const anchor = /\n## Verification\n/u;
        if (!anchor.test(body)) throw new Error("Could not find Verification section");
        body = body.replace(
          anchor,
          "\n## Documentation Writer Review\n\n" + replacement + "\n\n## Verification\n",
        );
      }
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
      prState: pr.state,
      headSha: localHead,
      agentsBlob,
      bodyChanged: previewBody !== pr.body,
      polls,
      waitedMs,
      updatedAt: null,
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
  const temporary = await run("umask 077; mktemp", "Create pull request body file");
  if (!temporary.startsWith("/") || /[\r\n\0]/.test(temporary))
    throw new Error("Could not create a safe pull request body file");
  let updated;
  try {
    await tools.write({ file_path: temporary, content: body });
    const updateResult = await github({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" + repo + "/pulls/" + input.number,
        "-X",
        "PATCH",
        "-F",
        "body=@" + temporary,
      ],
      timeoutMs: 30000,
      apply: true,
    });
    updated = JSON.parse(updateResult.stdout);
  } finally {
    await run("rm -f -- " + quote(temporary), "Remove pull request body file");
  }
  return {
    ok: true,
    apply: true,
    mutated: true,
    number: input.number,
    repo,
    prState: finalPr.state,
    headSha: localHead,
    agentsBlob,
    wouldUpdate: body !== finalPr.body,
    bodyChanged: body !== finalPr.body,
    polls,
    waitedMs,
    updatedAt: updated.updated_at ?? null,
  };
}
