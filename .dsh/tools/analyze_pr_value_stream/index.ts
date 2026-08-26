/**
 * Analyze one pull request from the earliest observable branch push through merge, separate approval delay from machine-controlled time, and test the latest revision against a target. Uses bounded authenticated GitHub reads; branch-push time falls back to commit time when no push workflow run is retained.
 */
export default async function analyze_pr_value_stream(input: {
  workdir: string;
  number: Integer;
  repository?: string;
  targetMinutes?: number;
  maxRunPages?: Integer;
  maxCheckPages?: Integer;
  maxAutomationRuns?: Integer;
  maxTestArtifacts?: Integer;
  topTestsPerShard?: Integer;
}): Promise<{
  measuredAt: string;
  repository: string;
  number: Integer;
  url: string;
  state: string;
  headSha: string;
  targetMinutes: number;
  events: {
    firstBranchPush: { at: string; source: string; confidence: string };
    pullRequestOpened: string;
    latestRevisionObserved: { at: string; source: string };
    firstFinalHeadApproval: string | null;
    automationSettled: string | null;
    merged: string | null;
  };
  elapsed: {
    observedTotalSeconds: number | null;
    branchPushToOpenSeconds: number;
    openToLatestRevisionSeconds: number;
    latestRevisionAutomationSeconds: number | null;
    approvalDelaySeconds: number | null;
    mergeLagAfterReadySeconds: number | null;
    approvalDiscountedSeconds: number | null;
  };
  target: {
    status: string;
    theoreticalFastestSeconds: number | null;
    marginSeconds: number | null;
    definition: string;
  };
  automation: {
    readinessBasis: string;
    checksConsidered: Integer;
    firstCheckCreatedAt: string | null;
    triggerDelaySeconds: number | null;
    longestRunnerQueue: { name: string; seconds: number } | null;
    longestChecks: { name: string; workflow: string; seconds: number; completedAt: string }[];
    lastCheck: { name: string; workflow: string; completedAt: string } | null;
  };
  waterfall: {
    origin: string;
    runsAvailable: Integer;
    runsIncluded: Integer;
    runsTruncated: boolean;
    runs: {
      id: Integer;
      name: string;
      event: string;
      attempt: Integer;
      status: string;
      conclusion: string | null;
      url: string;
      createdAt: string;
      startedAt: string;
      completedAt: string | null;
      offsetSeconds: number;
      queueSeconds: number;
      durationSeconds: number | null;
      jobs: {
        id: Integer;
        name: string;
        status: string;
        conclusion: string | null;
        url: string;
        runner: string | null;
        runnerGroup: string | null;
        labels: string[];
        createdAt: string;
        startedAt: string;
        completedAt: string | null;
        offsetSeconds: number;
        queueSeconds: number | null;
        durationSeconds: number | null;
        testRun: {
          artifact: string;
          tests: Integer;
          timedTests: Integer;
          files: Integer;
          startedAt: string;
          completedAt: string;
          offsetSeconds: number;
          durationSeconds: number;
          slowTests: {
            file: string;
            name: string;
            state: string;
            startedAt: string;
            offsetSeconds: number;
            durationSeconds: number;
          }[];
        } | null;
        steps: {
          number: Integer;
          name: string;
          status: string;
          conclusion: string | null;
          startedAt: string;
          completedAt: string | null;
          offsetSeconds: number;
          durationSeconds: number | null;
        }[];
      }[];
    }[];
  };
  bottlenecks: { name: string; seconds: number; owner: string }[];
  revisions: Integer;
  caveats: string[];
}> {
  if (!Number.isSafeInteger(input.number) || input.number < 1)
    throw new Error("number must be a positive integer");
  const repository = input.repository ?? "NVIDIA/NemoClaw";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new Error("repository must be owner/name");
  const targetMinutes = input.targetMinutes ?? 10;
  if (!Number.isFinite(targetMinutes) || targetMinutes <= 0 || targetMinutes > 1440)
    throw new Error("targetMinutes must be greater than 0 and at most 1440");
  const maxRunPages = input.maxRunPages ?? 3;
  const maxCheckPages = input.maxCheckPages ?? 3;
  const maxAutomationRuns = input.maxAutomationRuns ?? 50;
  const maxTestArtifacts = input.maxTestArtifacts ?? 12;
  const topTestsPerShard = input.topTestsPerShard ?? 10;
  if (!Number.isSafeInteger(maxRunPages) || maxRunPages < 1 || maxRunPages > 10)
    throw new Error("maxRunPages must be an integer from 1 through 10");
  if (!Number.isSafeInteger(maxCheckPages) || maxCheckPages < 1 || maxCheckPages > 10)
    throw new Error("maxCheckPages must be an integer from 1 through 10");
  if (!Number.isSafeInteger(maxAutomationRuns) || maxAutomationRuns < 1 || maxAutomationRuns > 100)
    throw new Error("maxAutomationRuns must be an integer from 1 through 100");
  if (!Number.isSafeInteger(maxTestArtifacts) || maxTestArtifacts < 0 || maxTestArtifacts > 24)
    throw new Error("maxTestArtifacts must be an integer from 0 through 24");
  if (!Number.isSafeInteger(topTestsPerShard) || topTestsPerShard < 1 || topTestsPerShard > 25)
    throw new Error("topTestsPerShard must be an integer from 1 through 25");
  const parseTime = (value: unknown, label: string): number => {
    if (typeof value !== "string") throw new Error(label + " was not a timestamp");
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error(label + " was not a valid timestamp");
    return time;
  };
  const iso = (time: number): string => new Date(time).toISOString();
  const seconds = (start: number, end: number): number =>
    Math.max(0, Math.round((end - start) / 1000));
  const offsetSeconds = (origin: number, time: number): number =>
    Math.round((time - origin) / 1000);
  const pullResult = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "pr",
      "view",
      String(input.number),
      "--repo",
      repository,
      "--json",
      "number,url,state,isDraft,createdAt,mergedAt,headRefName,headRefOid,commits,reviews",
    ],
  });
  const pull = JSON.parse(pullResult.stdout);
  if (
    pull === null ||
    typeof pull !== "object" ||
    pull.number !== input.number ||
    typeof pull.url !== "string" ||
    typeof pull.state !== "string" ||
    typeof pull.headRefName !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(pull.headRefOid) ||
    !Array.isArray(pull.commits) ||
    !Array.isArray(pull.reviews)
  )
    throw new Error("GitHub pull request response did not match the value-stream contract");
  if (pull.commits.length < 1 || pull.commits.length > 250)
    throw new Error("value-stream analysis requires between 1 and 250 pull request commits");
  const opened = parseTime(pull.createdAt, "createdAt");
  const merged = pull.mergedAt === null ? null : parseTime(pull.mergedAt, "mergedAt");
  const commits = pull.commits.map((commit: any) => {
    if (!/^[0-9a-f]{40,64}$/u.test(commit?.oid))
      throw new Error("pull request commit had an invalid object ID");
    return {
      oid: commit.oid as string,
      committed: parseTime(commit.committedDate, "commit committedDate"),
    };
  });
  const commitIds = new Set(commits.map((commit: any) => commit.oid));
  const branch = encodeURIComponent(pull.headRefName);
  const runs: any[] = [];
  for (let page = 1; page <= maxRunPages; page += 1) {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" + repository + "/actions/runs?branch=" + branch + "&per_page=100&page=" + page,
        "--jq",
        "[.workflow_runs[] | {id,event,head_sha,created_at,run_started_at,updated_at,status,conclusion,name}]",
      ],
    });
    const pageRuns = JSON.parse(result.stdout);
    if (!Array.isArray(pageRuns)) throw new Error("GitHub workflow runs response was not an array");
    runs.push(...pageRuns);
    if (pageRuns.length < 100) break;
    if (page === maxRunPages)
      throw new Error("workflow run history exceeded maxRunPages; increase the bounded limit");
  }
  const relevantRuns = runs.filter(
    (run: any) => commitIds.has(run?.head_sha) && Number.isFinite(Date.parse(run?.created_at)),
  );
  const pushRuns = relevantRuns.filter((run: any) => run.event === "push");
  const earliest = (values: any[]): any | null =>
    values
      .slice()
      .sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] ?? null;
  const firstPushRun = earliest(pushRuns);
  const firstAnyRun = earliest(relevantRuns);
  const firstCommit = commits.slice().sort((a: any, b: any) => a.committed - b.committed)[0];
  const firstSignal = firstPushRun ?? firstAnyRun;
  const firstPush = firstSignal
    ? parseTime(firstSignal.created_at, "first branch workflow run")
    : firstCommit.committed;
  const firstPushSource = firstPushRun
    ? "push workflow run"
    : firstAnyRun
      ? "earliest branch workflow run"
      : "first commit committedDate fallback";
  const firstPushConfidence = firstPushRun ? "high" : firstAnyRun ? "medium" : "low";
  const headRuns = relevantRuns.filter((run: any) => run.head_sha === pull.headRefOid);
  const headPush = earliest(headRuns.filter((run: any) => run.event === "push"));
  const headAny = earliest(headRuns);
  const finalCommit =
    commits.find((commit: any) => commit.oid === pull.headRefOid) ?? commits[commits.length - 1];
  const headSignal = headPush ?? headAny;
  const headObserved = headSignal
    ? parseTime(headSignal.created_at, "latest revision workflow run")
    : finalCommit.committed;
  const headSource = headPush
    ? "push workflow run"
    : headAny
      ? "earliest exact-head workflow run"
      : "head commit committedDate fallback";
  const exactHeadRuns = headRuns
    .filter((run: any) => Number.isSafeInteger(run?.id))
    .sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const waterfallRuns = exactHeadRuns
    .slice(0, maxAutomationRuns)
    .sort((a: any, b: any) =>
      String(a?.name ?? "").startsWith("CI PR #") === String(b?.name ?? "").startsWith("CI PR #")
        ? Date.parse(a.created_at) - Date.parse(b.created_at)
        : String(a?.name ?? "").startsWith("CI PR #")
          ? -1
          : 1,
    );
  const shardJobName = /^cli-test-shards \(([1-9]|1[0-2])\)$/u;
  const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const readTestRun = async (
    runId: number,
    headSha: string,
    shard: number,
    artifact: any,
  ): Promise<any | null> => {
    try {
      if (
        !Number.isSafeInteger(artifact?.id) ||
        artifact?.name !== "cli-blob-report-" + shard ||
        artifact?.expired !== false ||
        !Number.isSafeInteger(artifact?.size_in_bytes) ||
        artifact.size_in_bytes < 1 ||
        artifact.size_in_bytes > 25_000_000 ||
        artifact?.workflow_run_id !== runId ||
        artifact?.workflow_run_head_sha !== headSha
      )
        return null;
      const reporter = [
        'import { writeFileSync } from "node:fs";',
        "export default class ShardTimingReporter {",
        "  rows = []; files = new Set(); tests = 0; timedTests = 0; start = Infinity; end = -Infinity;",
        "  onTestCaseResult(test) {",
        "    this.tests++; const result = test?.task?.result; const file = String(test?.module?.moduleId ?? ''); this.files.add(file);",
        "    const duration = result?.duration; const startTime = result?.startTime;",
        "    if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(startTime) || startTime < 0) return;",
        "    this.timedTests++; this.start = Math.min(this.start, startTime); this.end = Math.max(this.end, startTime + duration);",
        "    this.rows.push({ file, name: String(test?.fullName ?? ''), state: String(result?.state ?? ''), startTime, duration });",
        "  }",
        "  onTestRunEnd() { this.rows.sort((a, b) => b.duration - a.duration || a.name.localeCompare(b.name)); writeFileSync(process.env.DSH_TEST_SUMMARY, JSON.stringify({ tests: this.tests, timedTests: this.timedTests, files: this.files.size, start: this.start, end: this.end, rows: this.rows.slice(0, Number(process.env.DSH_TOP_TESTS)) })); }",
        "}",
      ].join("\n");
      const script = [
        "set -euo pipefail",
        "umask 077",
        "tmp=$(mktemp -d)",
        'cleanup() { rm -rf -- "$tmp"; }',
        "trap cleanup EXIT HUP INT TERM",
        "zip=$tmp/artifact.zip",
        "blobdir=$tmp/blobs",
        'mkdir "$blobdir"',
        "printf '%s\n' " + shellQuote(reporter) + ' > "$tmp/reporter.mjs"',
        "gh api " +
          shellQuote("repos/" + repository + "/actions/artifacts/" + artifact.id + "/zip") +
          ' | { dd of="$zip" bs=1000000 count=25 iflag=fullblock status=none; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); [ -z "$extra" ]; }',
        'compressed=$(stat -c %s "$zip")',
        '[ "$compressed" -eq ' + String(artifact.size_in_bytes) + " ]",
        'entry=$(zipinfo -1 "$zip")',
        '[ "$(printf \'%s\\n\' "$entry" | wc -l)" -eq 1 ]',
        "printf '%s\\n' \"$entry\" | grep -Eq '^blob-[A-Za-z0-9._-]+\\.json$'",
        "line=$(zipinfo -l \"$zip\" | awk '/^-/{print; found++} END {if (found != 1) exit 1}')",
        "mode=$(printf '%s\\n' \"$line\" | awk '{print $1}')",
        "expanded=$(printf '%s\\n' \"$line\" | awk '{print $4}')",
        'case "$mode" in -*) ;; *) exit 1 ;; esac',
        "case \"$expanded\" in ''|*[!0-9]*) exit 1 ;; esac",
        '[ "$expanded" -le 100000000 ]',
        'unzip -p "$zip" "$entry" | { dd of="$blobdir/$entry" bs=1000000 count=100 iflag=fullblock status=none; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); [ -z "$extra" ]; }',
        '[ "$(stat -c %s "$blobdir/$entry")" -eq "$expanded" ]',
        "common=$(git rev-parse --path-format=absolute --git-common-dir)",
        "primary=${common%/.git}",
        "owner=$PWD",
        'if [ ! -x "$owner/node_modules/.bin/vitest" ]; then owner=$primary; fi',
        '[ -x "$owner/node_modules/.bin/vitest" ]',
        "summary=$tmp/summary.json",
        "set +e",
        '(cd "$owner" && DSH_TEST_SUMMARY="$summary" DSH_TOP_TESTS=' +
          String(topTestsPerShard) +
          ' ./node_modules/.bin/vitest --merge-reports="$blobdir" --reporter="$tmp/reporter.mjs") >/dev/null 2>"$tmp/vitest.stderr"',
        "set -e",
        '[ -f "$summary" ]',
        '[ "$(stat -c %s "$summary")" -le 5000000 ]',
        'cat "$summary"',
      ].join("\n");
      const result = await tools.bash({
        workdir: input.workdir,
        command: script,
        description: "Merge bounded Vitest shard artifact",
        timeoutMs: 120_000,
      });
      if (
        result.kind !== "foreground" ||
        result.exitCode !== 0 ||
        result.timedOut ||
        result.stdout.truncated ||
        result.stdout.text.length > 5_000_000
      )
        return null;
      const summary = JSON.parse(result.stdout.text);
      if (
        !Number.isSafeInteger(summary?.tests) ||
        !Number.isSafeInteger(summary?.timedTests) ||
        !Number.isSafeInteger(summary?.files) ||
        !Array.isArray(summary?.rows) ||
        summary.rows.length > topTestsPerShard ||
        !Number.isFinite(summary?.start) ||
        !Number.isFinite(summary?.end) ||
        summary.end < summary.start
      )
        return null;
      const rows = summary.rows.map((record: any) => ({
        file: String(record?.file ?? "")
          .replace(/^.*\/NemoClaw\/NemoClaw\//u, "")
          .slice(0, 500),
        name: String(record?.name ?? "").slice(0, 500),
        state: String(record?.state ?? "").slice(0, 40),
        start:
          typeof record?.startTime === "number" && Number.isFinite(record.startTime)
            ? record.startTime
            : null,
        duration:
          typeof record?.duration === "number" &&
          Number.isFinite(record.duration) &&
          record.duration >= 0
            ? record.duration
            : null,
      }));
      const timed = rows.filter((row: any) => row.start !== null && row.duration !== null);
      const started = summary.start;
      const completed = summary.end;
      return {
        artifact: artifact.name,
        tests: summary.tests,
        timedTests: summary.timedTests,
        files: summary.files,
        startedAt: iso(started),
        completedAt: iso(completed),
        offsetSeconds: offsetSeconds(headObserved, started),
        durationSeconds: seconds(started, completed),
        slowTests: timed
          .slice()
          .sort((a: any, b: any) => b.duration - a.duration || a.name.localeCompare(b.name))
          .slice(0, topTestsPerShard)
          .map((row: any) => ({
            file: row.file,
            name: row.name,
            state: row.state,
            startedAt: iso(row.start),
            offsetSeconds: offsetSeconds(headObserved, row.start),
            durationSeconds: Math.max(0, Math.round(row.duration / 1000)),
          })),
      };
    } catch {
      return null;
    }
  };
  let testArtifactsRead = 0;
  const waterfall = [];
  for (let index = 0; index < waterfallRuns.length; index += 4) {
    const batch = await Promise.all(
      waterfallRuns.slice(index, index + 4).map(async (run: any) => {
      const runResult = await tools.run_github_cli({
        workdir: input.workdir,
        args: [
          "api",
          "repos/" + repository + "/actions/runs/" + run.id,
          "--jq",
          "{id,name,event,run_attempt,head_sha,status,conclusion,created_at,run_started_at,updated_at,html_url}",
        ],
      });
      const runDetails = JSON.parse(runResult.stdout);
      if (
        runDetails?.id !== run.id ||
        runDetails?.head_sha !== pull.headRefOid ||
        !Number.isSafeInteger(runDetails?.run_attempt)
      )
        throw new Error("workflow run did not match the exact-head waterfall contract");
      const jobsResult = await tools.run_github_cli({
        workdir: input.workdir,
        args: [
          "api",
          "repos/" + repository + "/actions/runs/" + run.id + "/jobs?filter=latest&per_page=100",
          "--jq",
          "{total_count,jobs:[.jobs[] | {id,name,status,conclusion,created_at,started_at,completed_at,runner_name,runner_group_name,labels,html_url,steps}]}",
        ],
      });
      const jobsPayload = JSON.parse(jobsResult.stdout);
      if (
        !Number.isSafeInteger(jobsPayload?.total_count) ||
        !Array.isArray(jobsPayload?.jobs) ||
        jobsPayload.total_count > 100 ||
        jobsPayload.jobs.length !== jobsPayload.total_count
      )
        throw new Error("workflow job list exceeded the complete bounded waterfall contract");
      const runCreated = parseTime(run.created_at, "workflow createdAt");
      const shardJobs = jobsPayload.jobs.filter((job: any) => shardJobName.test(job?.name));
      let artifactsByName = new Map<string, any>();
      if (shardJobs.length > 0 && maxTestArtifacts > 0) {
        try {
          const artifactsResult = await tools.run_github_cli({
            workdir: input.workdir,
            args: [
              "api",
              "repos/" + repository + "/actions/runs/" + run.id + "/artifacts?per_page=100",
              "--jq",
              "{total_count,artifacts:[.artifacts[] | {id,name,size_in_bytes,expired,workflow_run_id:.workflow_run.id,workflow_run_head_sha:.workflow_run.head_sha}]}",
            ],
          });
          const payload = JSON.parse(artifactsResult.stdout);
          if (
            Number.isSafeInteger(payload?.total_count) &&
            payload.total_count <= 100 &&
            Array.isArray(payload?.artifacts) &&
            payload.artifacts.length === payload.total_count
          ) {
            const counts = new Map<string, number>();
            for (const artifact of payload.artifacts)
              counts.set(artifact?.name, (counts.get(artifact?.name) ?? 0) + 1);
            artifactsByName = new Map(
              payload.artifacts
                .filter((artifact: any) => counts.get(artifact?.name) === 1)
                .map((artifact: any) => [artifact.name, artifact]),
            );
          }
        } catch {
          artifactsByName = new Map();
        }
      }
      const jobs = [];
      for (const job of jobsPayload.jobs) {
        if (!Number.isSafeInteger(job?.id) || !Array.isArray(job?.steps))
          throw new Error("workflow job did not match the waterfall contract");
        const jobCreated = parseTime(job.created_at, "job createdAt");
        const jobStarted = parseTime(job.started_at, "job startedAt");
        const jobCompleted =
          job.completed_at === null ? null : parseTime(job.completed_at, "job completedAt");
        let testRun = null;
        const match = shardJobName.exec(job.name);
        if (match !== null && testArtifactsRead < maxTestArtifacts) {
          const artifact = artifactsByName.get("cli-blob-report-" + match[1]);
          if (artifact !== undefined) {
            testArtifactsRead += 1;
            testRun = await readTestRun(run.id, pull.headRefOid, Number(match[1]), artifact);
          }
        }
        const steps = job.steps.map((step: any) => {
          if (!Number.isSafeInteger(step?.number))
            throw new Error("workflow step did not match the waterfall contract");
          const stepStarted = parseTime(step.started_at, "step startedAt");
          const stepCompleted =
            step.completed_at === null ? null : parseTime(step.completed_at, "step completedAt");
          return {
            number: step.number,
            name: String(step.name ?? "").slice(0, 200),
            status: String(step.status ?? "").slice(0, 40),
            conclusion:
              step.conclusion === null ? null : String(step.conclusion ?? "").slice(0, 40),
            startedAt: iso(stepStarted),
            completedAt: stepCompleted === null ? null : iso(stepCompleted),
            offsetSeconds: offsetSeconds(headObserved, stepStarted),
            durationSeconds: stepCompleted === null ? null : seconds(stepStarted, stepCompleted),
          };
        });
        const normalizedJob = {
          id: job.id,
          name: String(job.name ?? "").slice(0, 200),
          status: String(job.status ?? "").slice(0, 40),
          conclusion: job.conclusion === null ? null : String(job.conclusion ?? "").slice(0, 40),
          url: String(job.html_url ?? "").slice(0, 500),
          runner: job.runner_name === null ? null : String(job.runner_name ?? "").slice(0, 200),
          runnerGroup:
            job.runner_group_name === null
              ? null
              : String(job.runner_group_name ?? "").slice(0, 200),
          labels: job.labels.slice(0, 20).map((label: any) => String(label).slice(0, 100)),
          createdAt: iso(jobCreated),
          startedAt: iso(jobStarted),
          completedAt: jobCompleted === null ? null : iso(jobCompleted),
          offsetSeconds: offsetSeconds(headObserved, jobStarted),
          queueSeconds: jobCreated <= jobStarted ? seconds(jobCreated, jobStarted) : null,
          durationSeconds: jobCompleted === null ? null : seconds(jobStarted, jobCompleted),
          testRun,
          steps,
        };
        jobs.push(normalizedJob);
      }
      const earliestJobStart =
        jobs.length > 0
          ? Math.min(
              ...jobs.map((job: any) => parseTime(job.startedAt, "normalized job startedAt")),
            )
          : parseTime(runDetails.run_started_at, "workflow startedAt");
      const runStarted = Math.min(
        parseTime(runDetails.run_started_at, "workflow startedAt"),
        earliestJobStart,
      );
      const runCompleted =
        runDetails.status === "completed"
          ? parseTime(runDetails.updated_at, "workflow completedAt")
          : null;
      return {
        id: runDetails.id,
        name: String(runDetails.name ?? "").slice(0, 200),
        event: String(runDetails.event ?? "").slice(0, 60),
        attempt: runDetails.run_attempt,
        status: String(runDetails.status ?? "").slice(0, 40),
        conclusion:
          runDetails.conclusion === null ? null : String(runDetails.conclusion ?? "").slice(0, 40),
        url: String(runDetails.html_url ?? "").slice(0, 500),
        createdAt: iso(runCreated),
        startedAt: iso(runStarted),
        completedAt: runCompleted === null ? null : iso(runCompleted),
        offsetSeconds: offsetSeconds(headObserved, runCreated),
        queueSeconds: seconds(runCreated, runStarted),
        durationSeconds: runCompleted === null ? null : seconds(runStarted, runCompleted),
          jobs,
        };
      }),
    );
    waterfall.push(...batch);
  }
  const checks: any[] = [];
  for (let page = 1; page <= maxCheckPages; page += 1) {
    const result = await tools.run_github_cli({
      workdir: input.workdir,
      args: [
        "api",
        "repos/" +
          repository +
          "/commits/" +
          pull.headRefOid +
          "/check-runs?per_page=100&page=" +
          page,
        "--jq",
        "[.check_runs[] | {id,name,status,conclusion,created_at,started_at,completed_at,html_url,app:{slug:.app.slug}}]",
      ],
    });
    const pageChecks = JSON.parse(result.stdout);
    if (!Array.isArray(pageChecks)) throw new Error("GitHub check runs response was not an array");
    checks.push(...pageChecks);
    if (pageChecks.length < 100) break;
    if (page === maxCheckPages)
      throw new Error("check run history exceeded maxCheckPages; increase the bounded limit");
  }
  let requiredNames = new Set<string>();
  let readinessBasis = "all successful exact-head check runs observed before merge";
  try {
    const configured = await tools.summarize_nemoclaw_required_checks({
      workdir: input.workdir,
      repo: repository,
      number: input.number,
      limit: 100,
    });
    if (configured.summary.protectionReadable && configured.items.length > 0) {
      requiredNames = new Set(
        configured.items.flatMap((item: any) => item.matches.map((match: any) => match.name)),
      );
      if (requiredNames.size > 0)
        readinessBasis = "required checks reported by current base-branch protection";
    }
  } catch {
    readinessBasis =
      "all successful exact-head check runs observed before merge; required-check configuration was unavailable";
  }
  const terminalLimit = merged ?? Date.now();
  const successful = checks.filter((check: any) => {
    const completed = Date.parse(check?.completed_at);
    const conclusion = String(check?.conclusion ?? "").toUpperCase();
    const selected = requiredNames.size === 0 || requiredNames.has(check?.name);
    return (
      selected &&
      conclusion === "SUCCESS" &&
      Number.isFinite(completed) &&
      completed >= headObserved &&
      completed <= terminalLimit
    );
  });
  successful.sort((a: any, b: any) => Date.parse(a.completed_at) - Date.parse(b.completed_at));
  const automationSettled =
    successful.length > 0
      ? parseTime(successful[successful.length - 1].completed_at, "last check completedAt")
      : null;
  const finalApprovals = pull.reviews.filter(
    (review: any) =>
      review?.state === "APPROVED" &&
      review?.commit?.oid === pull.headRefOid &&
      Number.isFinite(Date.parse(review?.submittedAt)),
  );
  finalApprovals.sort((a: any, b: any) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const approval =
    finalApprovals.length > 0
      ? parseTime(finalApprovals[0].submittedAt, "approval submittedAt")
      : null;
  const machineReady = automationSettled;
  const ready =
    machineReady === null
      ? approval
      : approval === null
        ? machineReady
        : Math.max(machineReady, approval);
  const mergeLag = merged !== null && ready !== null ? seconds(ready, merged) : null;
  const approvalDelay =
    machineReady !== null && approval !== null
      ? seconds(machineReady, Math.max(machineReady, approval))
      : null;
  const observedTotal = merged === null ? null : seconds(firstPush, merged);
  const discounted =
    merged !== null && machineReady !== null && ready !== null
      ? seconds(firstPush, machineReady) + seconds(ready, merged)
      : null;
  const latestAutomation = machineReady === null ? null : seconds(headObserved, machineReady);
  const theoretical = latestAutomation === null ? null : latestAutomation + (mergeLag ?? 0);
  const targetSeconds = Math.round(targetMinutes * 60);
  const targetStatus =
    theoretical === null
      ? "not-measurable"
      : theoretical <= targetSeconds
        ? "within-target"
        : "over-target";
  const checkRows = successful.map((check: any) => {
    const started = parseTime(check.started_at, "check startedAt");
    const completed = parseTime(check.completed_at, "check completedAt");
    return {
      name: String(check.name).slice(0, 200),
      workflow: String(check.app?.slug ?? "").slice(0, 100),
      started,
      completed,
      duration: seconds(started, completed),
    };
  });
  const firstCheckCreated =
    checkRows.length > 0 ? Math.min(...checkRows.map((row: any) => row.started)) : null;
  const longestQueue =
    waterfall
      .flatMap((run: any) => run.jobs)
      .filter((job: any) => job.queueSeconds !== null)
      .sort(
        (a: any, b: any) =>
          b.queueSeconds - a.queueSeconds || a.name.localeCompare(b.name),
      )[0] ?? null;
  const longestChecks = checkRows
    .slice()
    .sort((a: any, b: any) => b.duration - a.duration || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((row: any) => ({
      name: row.name,
      workflow: row.workflow,
      seconds: row.duration,
      completedAt: iso(row.completed),
    }));
  const last = checkRows.slice().sort((a: any, b: any) => b.completed - a.completed)[0] ?? null;
  const bottlenecks: { name: string; seconds: number; owner: string }[] = [];
  bottlenecks.push({
    name: "branch push to pull request open",
    seconds: seconds(firstPush, Math.max(firstPush, opened)),
    owner: "contributor process",
  });
  bottlenecks.push({
    name: "pull request open to latest revision",
    seconds: seconds(opened, Math.max(opened, headObserved)),
    owner: "change iteration",
  });
  if (firstCheckCreated !== null)
    bottlenecks.push({
      name: "latest revision to first selected check",
      seconds: seconds(headObserved, firstCheckCreated),
      owner: "GitHub automation",
    });

  if (longestChecks.length > 0)
    bottlenecks.push({
      name: "longest selected check execution",
      seconds: longestChecks[0].seconds,
      owner: "check implementation",
    });
  if (approvalDelay !== null)
    bottlenecks.push({
      name: "approval delay after automation",
      seconds: approvalDelay,
      owner: "human approval",
    });
  if (mergeLag !== null)
    bottlenecks.push({ name: "ready to merge", seconds: mergeLag, owner: "merge process" });
  bottlenecks.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
  const caveats = [
    "GitHub does not expose a canonical branch-created timestamp. The first branch push is the earliest retained push workflow run for a PR commit, with explicit lower-confidence fallbacks.",
    "The theoretical fastest value reuses the latest revision's observed automation span and observed merge lag. It assumes one push, an immediately opened PR, passing checks, and immediate approval.",
    "Approval delay is a counterfactual attribution, not a causal trace. Approval-triggered automation remains machine time.",
    "Check summaries do not expose runner assignment time. The waterfall uses each GitHub Actions job's created_at to started_at interval as its observed queue time.",
    "Workflow completion uses updated_at because the workflow-run API does not return a separate completed_at timestamp. Rerun workflows begin at the earliest retained job start so reused jobs remain visible in one logical run.",
    "GitHub can return a reused job with created_at later than started_at. Such jobs retain both timestamps but report queueSeconds as null; job offset begins at started_at.",
    readinessBasis.startsWith("required checks")
      ? "Required checks reflect current base-branch protection and may differ from the rules active when an older PR merged."
      : "Required-check configuration was not available, so successful exact-head checks are an upper-bound proxy for automation readiness.",
  ];
  if (pull.isDraft)
    caveats.push(
      "The pull request is or was returned as draft; draft waiting is not separately observable in this bounded snapshot.",
    );
  if (merged === null)
    caveats.push(
      "The pull request has not merged, so total lead time, merge lag, and approval-discounted lead time are incomplete.",
    );
  if (automationSettled === null)
    caveats.push("No selected successful exact-head check completed in the measured window.");
  return {
    measuredAt: new Date().toISOString(),
    repository,
    number: input.number,
    url: pull.url,
    state: pull.state,
    headSha: pull.headRefOid,
    targetMinutes,
    events: {
      firstBranchPush: {
        at: iso(firstPush),
        source: firstPushSource,
        confidence: firstPushConfidence,
      },
      pullRequestOpened: iso(opened),
      latestRevisionObserved: { at: iso(headObserved), source: headSource },
      firstFinalHeadApproval: approval === null ? null : iso(approval),
      automationSettled: automationSettled === null ? null : iso(automationSettled),
      merged: merged === null ? null : iso(merged),
    },
    elapsed: {
      observedTotalSeconds: observedTotal,
      branchPushToOpenSeconds: seconds(firstPush, Math.max(firstPush, opened)),
      openToLatestRevisionSeconds: seconds(opened, Math.max(opened, headObserved)),
      latestRevisionAutomationSeconds: latestAutomation,
      approvalDelaySeconds: approvalDelay,
      mergeLagAfterReadySeconds: mergeLag,
      approvalDiscountedSeconds: discounted,
    },
    target: {
      status: targetStatus,
      theoreticalFastestSeconds: theoretical,
      marginSeconds: theoretical === null ? null : targetSeconds - theoretical,
      definition:
        "latest revision observed to selected automation settled, plus observed ready-to-merge lag; PR opening and approval are immediate",
    },
    automation: {
      readinessBasis,
      checksConsidered: checkRows.length,
      firstCheckCreatedAt: firstCheckCreated === null ? null : iso(firstCheckCreated),
      triggerDelaySeconds:
        firstCheckCreated === null ? null : seconds(headObserved, firstCheckCreated),
      longestRunnerQueue:
        longestQueue === null
          ? null
          : { name: longestQueue.name, seconds: longestQueue.queueSeconds },
      longestChecks,
      lastCheck:
        last === null
          ? null
          : { name: last.name, workflow: last.workflow, completedAt: iso(last.completed) },
    },
    waterfall: {
      origin: iso(headObserved),
      runsAvailable: exactHeadRuns.length,
      runsIncluded: waterfall.length,
      runsTruncated: waterfall.length < exactHeadRuns.length,
      runs: waterfall,
    },
    bottlenecks,
    revisions: commits.length,
    caveats,
  };
}
