// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const jobId = String(input.jobId);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^\d+$/.test(jobId) || jobId === "0")
  throw new Error("jobId must be a positive numeric GitHub Actions job ID");
const tailLines = Math.max(20, Math.min(500, input.tailLines ?? 260));
const artifactName = input.artifactName?.trim() ?? "";
if (
  input.artifactName !== undefined &&
  (artifactName !== input.artifactName || !/^[A-Za-z0-9_. -]{1,200}$/.test(artifactName))
)
  throw new Error("artifactName must be a trimmed GitHub Actions artifact name");
const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const run = async (command, description, timeoutMs = 30000) => {
  const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
  if (result.kind !== "foreground") throw new Error("Unexpected background result");
  return result;
};
const jobResult = await run(
  `gh api ${q(`repos/${repo}/actions/jobs/${jobId}`)}`,
  "Read GitHub Actions job metadata",
);
if (jobResult.exitCode !== 0)
  throw new Error(`Could not read job metadata: ${jobResult.stderr.text.slice(-1500)}`);
const rawJob = JSON.parse(jobResult.stdout.text);
const job = {
  id: Number(rawJob.id ?? jobId),
  runId: Number(rawJob.run_id ?? 0),
  name: String(rawJob.name ?? "").slice(0, 500),
  status: String(rawJob.status ?? "").slice(0, 100),
  conclusion: rawJob.conclusion == null ? null : String(rawJob.conclusion).slice(0, 100),
  url: String(rawJob.html_url ?? "").slice(0, 2000),
};
const logScript =
  "import json,re,subprocess,sys\nrepo,job,tail=sys.argv[1:]\np=subprocess.run(['gh','api',f'repos/{repo}/actions/jobs/{job}/logs'],capture_output=True)\ntext=p.stdout.decode('utf-8','replace').splitlines()\npat=re.compile(r'FAIL|Failed Tests|AssertionError|Test timed out|Process completed|SIGKILL|timed out|Source-shape|Source architecture|grew by|adds JavaScript|NEMOCLAW_|npm audit report|docs-review|Documentation writer|Fern validation|check-docs|hadolint|shellcheck|Nemotron',re.I)\nidx=set(); matches=0\nfor i,line in enumerate(text):\n if pat.search(line): matches+=1; idx.update(range(max(0,i-20),min(len(text),i+21)))\nselected=[text[i][:4000] for i in sorted(idx)][-int(tail):]\nout='\\n'.join(selected); out=out[-40000:]\nprint(json.dumps({'code':p.returncode,'stdout':out,'stderr':p.stderr.decode('utf-8','replace')[-4000:],'matchedLines':matches,'truncated':len(idx)>len(selected)}))";
const logResult = await run(
  `python3 -c ${q(logScript)} ${q(repo)} ${q(jobId)} ${q(tailLines)}`,
  "Inspect bounded GitHub job log",
  60000,
);
if (logResult.exitCode !== 0) throw new Error("Could not inspect job log");
const parsedLog = JSON.parse(logResult.stdout.text);
const log = {
  jobId,
  repo,
  pattern: "NemoClaw CI failure signatures",
  code: Number(parsedLog.code ?? -1),
  truncated: Boolean(parsedLog.truncated),
  matchedLines: Number(parsedLog.matchedLines ?? 0),
  stdout: String(parsedLog.stdout ?? "").slice(-40000),
  stderr: String(parsedLog.stderr ?? "").slice(-4000),
};
let artifact = null;
if (artifactName) {
  const inventoryResult = await run(
    `gh api ${q(`repos/${repo}/actions/runs/${job.runId}/artifacts?per_page=100`)}`,
    "Read workflow artifact inventory",
  );
  if (inventoryResult.exitCode !== 0) throw new Error("Could not read artifact inventory");
  const inventory = JSON.parse(inventoryResult.stdout.text);
  const found = (inventory.artifacts ?? []).find((entry) => entry.name === artifactName);
  if (!found) throw new Error(`Artifact ${artifactName} was not found for run ${job.runId}`);
  const sizeBytes = Number(found.size_in_bytes ?? 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes > 25000000)
    throw new Error(`Artifact ${artifactName} is too large for bounded inspection`);
  const temp = await run(
    'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-ci-triage.XXXXXX"',
    "Create temporary artifact directory",
  );
  if (temp.exitCode !== 0) throw new Error("Could not create temporary artifact directory");
  const dir = temp.stdout.text.trim();
  try {
    const download = await run(
      `gh run download ${q(job.runId)} --repo ${q(repo)} --name ${q(artifactName)} --dir ${q(dir)}`,
      "Download selected workflow artifact",
      60000,
    );
    if (download.exitCode !== 0) throw new Error("Could not download selected artifact");
    const parser =
      "import json,pathlib,sys\nr=pathlib.Path(sys.argv[1]); fs=sorted(r.rglob('*.result.json'))[:101]; rows=[]\nfor p in fs[:100]:\n try: d=json.loads(p.read_text(errors='replace'))\n except Exception: continue\n ec=d.get('exitCode'); sig=d.get('signal'); err=d.get('error'); to=bool(d.get('timedOut'))\n if ec not in (None,0) or sig or err or to or (ec is None and d.get('command')): rows.append({'path':str(p.relative_to(r))[:1000],'exitCode':ec if isinstance(ec,int) else None,'signal':str(sig)[:100] if sig else None,'timedOut':to,'error':str(err)[:1000] if err else None,'command':str(d.get('command'))[:2000] if d.get('command') is not None else None})\nprint(json.dumps({'filesRead':min(len(fs),100),'filesTruncated':len(fs)>100,'failures':rows[:20],'failuresTruncated':len(rows)>20}))";
    const parsed = await run(
      `python3 -c ${q(parser)} ${q(dir)}`,
      "Parse bounded test result artifacts",
    );
    if (parsed.exitCode !== 0) throw new Error("Could not parse selected artifact");
    artifact = {
      name: artifactName,
      sizeBytes,
      inventoryTruncated: Number(inventory.total_count ?? 0) > 100,
      ...JSON.parse(parsed.stdout.text),
    };
  } finally {
    await run(`rm -rf ${q(dir)}`, "Remove temporary artifact directory");
  }
}
if (log.code !== 0)
  return {
    jobId,
    repo,
    job,
    result: "log-error",
    categories: [],
    findings: [],
    nextActions: [],
    artifact,
    log,
  };
const text = `${job.name}\n${log.stdout}\n${log.stderr}`;
const findings = [];
const add = (type, detail, suggestion) =>
  findings.push({ type, detail: detail.slice(0, 4000), suggestion: suggestion.slice(0, 1000) });
const signalled = (artifact?.failures ?? []).filter((failure) => failure.signal);
if (signalled.length)
  add(
    "process-signal",
    `A captured command ended with ${signalled[0].signal}.`,
    "Inspect timeout and resource evidence before changing behavior or retrying the same commit.",
  );
if (/AssertionError|Test timed out|Failed Tests|Vitest|Tests?\s+\d+\s+failed/i.test(text))
  add(
    "test-failure",
    "A test assertion, timeout, or Vitest failure was reported.",
    "Run the named failing test in its Vitest project and inspect the first assertion or timeout.",
  );
const onboard = text.match(/FAIL: (src\/lib\/onboard\.ts) grew by (\d+) line\(s\)\./);
if (onboard)
  add(
    "onboard-entrypoint-growth",
    `${onboard[1]} grew by ${onboard[2]} line(s).`,
    "Move new logic under src/lib/onboard/ or make the entry point net-neutral or smaller.",
  );
if (/FAIL: this PR adds JavaScript source files/i.test(text))
  add(
    "new-javascript-source",
    "The PR adds JavaScript source files.",
    "Use TypeScript for new Node.js source, test, and script files.",
  );
if (/Source architecture budget failed/i.test(text))
  add(
    "source-architecture-budget",
    "Source architecture budget failed.",
    "Reduce imports or exports, move code behind an existing boundary, or lower a limit only when measured debt decreases.",
  );
if (/Source-shape test budget|source-shape exception|source_shape/i.test(text))
  add(
    "source-shape-budget",
    "The source-shape test budget failed.",
    "Prefer behavior tests; otherwise repair the documented source-shape contract and its narrow budget entry.",
  );
if (/NEMOCLAW_\* env-var documentation gate[\s\S]*(Failed|FAIL|missing|undocumented)/i.test(text))
  add(
    "env-var-documentation",
    "The environment-variable documentation gate failed.",
    "Document the new NEMOCLAW_* variable in the required reference or remove it.",
  );
if (
  /reviewed-npm-audit/i.test(job.name) ||
  /reviewed npm audit|npm audit report|audit-reviewed-npm-graph/i.test(text)
)
  add(
    "reviewed-npm-audit",
    "The reviewed npm audit check reported advisory drift.",
    "Determine whether this is live advisory drift or update the reviewed baseline through the security process.",
  );
if (/docs-review|Documentation writer review/i.test(text))
  add(
    "docs-review-receipt",
    "The documentation writer review receipt failed.",
    "Rerun the review for the current commit and refresh both hidden SHA fields.",
  );
if (/Fern validation|check-docs|npm run docs/i.test(text))
  add(
    "docs-validation",
    "Documentation validation failed.",
    "Run npm run docs and fix the reported route, frontmatter, or MDX error.",
  );
if (/hadolint|DL\d{4}/.test(text))
  add(
    "hadolint",
    "Hadolint reported a Dockerfile diagnostic.",
    "Fix the Dockerfile diagnostic or use a narrow policy-approved ignore.",
  );
if (/shellcheck|SC\d{4}/i.test(text))
  add(
    "shellcheck",
    "ShellCheck reported a shell diagnostic.",
    "Run the targeted ShellCheck and shfmt checks and fix the diagnostic.",
  );
if (/PR review advisor/i.test(job.name) && /Nemotron 3 Ultra|second-opinion/i.test(text))
  add(
    "advisor-second-opinion",
    "The Nemotron second-opinion check reported a failure.",
    "Treat it as advisory unless the primary advisor or a maintainer identifies a concrete blocker.",
  );
const boundedFindings = findings.slice(0, 20);
return {
  jobId,
  repo,
  job,
  result: boundedFindings.length ? "classified" : "unclassified",
  categories: [...new Set(boundedFindings.map((item) => item.type))],
  findings: boundedFindings,
  nextActions: [...new Set(boundedFindings.map((item) => item.suggestion))],
  artifact,
  log,
};
