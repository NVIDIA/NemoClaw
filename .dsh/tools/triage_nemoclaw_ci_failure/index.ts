/**
 * Classify a NemoClaw GitHub Actions failure with bounded logs and optional artifact inspection. Requires Bash, GNU dd and find, Info-ZIP zipinfo and unzip, awk, base64, mktemp, stat, and wc on Linux.
 */
export default async function triage_nemoclaw_ci_failure(input: {
  workdir: string;
  jobId: Integer | string;
  repo?: string;
  artifactName?: string /** Maximum matched log and context lines to return; defaults to 120 and is capped at 500. */;
  maxLines?: Integer /** Which end of matched log output to retain when clipping; defaults to tail. */;
  clipMode?: "head" | "tail";
}): Promise<{
  jobId: string;
  repo: string;
  job: {
    id: Integer;
    runId: Integer;
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
  };
  result: "classified" | "unclassified" | "log-error";
  categories: string[];
  findings: { type: string; detail: string; suggestion: string }[];
  nextActions: string[];
  artifact: {
    name: string;
    sizeBytes: Integer;
    inventoryTruncated: boolean;
    filesRead: Integer;
    filesTruncated: boolean;
    failures: {
      path: string;
      exitCode: Integer | null;
      signal: string | null;
      timedOut: boolean;
      error: string | null;
      command: string | null;
    }[];
    failuresTruncated: boolean;
  } | null;
  log: {
    jobId: string;
    repo: string;
    code: Integer;
    truncated: boolean;
    matchedLines: Integer;
    stdout: string;
    stderr: string;
    pattern: string | null;
    truncationNotice: string | null;
    truncationReasons: string[];
    clipMode: "head" | "tail";
    maxLines: Integer;
    selectedLines: Integer;
    returnedLines: Integer;
    omittedLines: Integer;
  };
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  const jobId = String(input.jobId);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!/^\d+$/.test(jobId) || jobId === "0")
    throw new Error("jobId must be a positive numeric GitHub Actions job ID");
  const maxLines = Math.max(1, Math.min(500, input.maxLines ?? 120));
  const clipMode = input.clipMode ?? "tail";
  if (!new Set(["head", "tail"]).has(clipMode)) throw new Error("clipMode must be head or tail");
  const artifactName = input.artifactName?.trim() ?? "";
  if (
    input.artifactName !== undefined &&
    (artifactName !== input.artifactName || !/^[A-Za-z0-9_. -]{1,200}$/.test(artifactName))
  )
    throw new Error("artifactName must be a trimmed GitHub Actions artifact name");
  const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const project = async (value, maxCharacters, maxLineCharacters = maxCharacters) =>
    tools.project_diagnostic_text({
      lines: [String(value)],
      clipMode: "tail",
      lineClipMode: "tail",
      maxLines: 40,
      maxCharacters,
      maxLineCharacters,
    });
  const diagnosticError = async (message) => {
    const projected = await project(message, 2000, 1000);
    return new Error(projected.text || "Diagnostic unavailable");
  };
  const github = async (args, timeoutMs = 30000) => {
    try {
      return await tools.run_github_cli({ workdir: input.workdir, args, timeoutMs });
    } catch (error) {
      throw await diagnosticError(error instanceof Error ? error.message : String(error));
    }
  };
  const run = async (command, description, timeoutMs = 30000) => {
    const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
    if (result.kind !== "foreground") throw new Error("Unexpected background result");
    const detail = (result.stderr.text + "\n" + result.stdout.text).toLowerCase();
    if (
      result.exitCode !== 0 &&
      [
        "authentication",
        "authorization",
        "forbidden",
        "not authorized",
        "http 401",
        "http 403",
        "resource not accessible",
        "sso",
      ].some((value) => detail.includes(value))
    ) {
      const projected = await project(result.stderr.text, 1500, 1000);
      throw new Error(
        "GitHub access failed; correct authentication or authorization before retrying." +
          (projected.text ? "\n" + projected.text : ""),
      );
    }
    return result;
  };
  const jobResult = await github(["api", `repos/${repo}/actions/jobs/${jobId}`]);
  const rawJob = JSON.parse(jobResult.stdout);
  const job = {
    id: Number(rawJob.id ?? jobId),
    runId: Number(rawJob.run_id ?? 0),
    name: String(rawJob.name ?? "").slice(0, 500),
    status: String(rawJob.status ?? "").slice(0, 100),
    conclusion: rawJob.conclusion == null ? null : String(rawJob.conclusion).slice(0, 100),
    url: String(rawJob.html_url ?? "").slice(0, 2000),
  };
  const logTemp = await run(
    'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-ci-log.XXXXXX"',
    "Create temporary CI log directory",
  );
  if (logTemp.exitCode !== 0) throw new Error("Could not create temporary CI log directory");
  const logDir = logTemp.stdout.text.trim();
  if (!logDir) throw new Error("Could not create temporary CI log directory");
  let logCode = -1;
  let logStderr = "";
  let sourceTruncated = false;
  let logLines = [];
  try {
    const rawPath = logDir + "/job.log";
    const boundedPath = logDir + "/job.tail.log";
    const downloaded = await run(
      `gh api ${q(`repos/${repo}/actions/jobs/${jobId}/logs`)} > ${q(rawPath)}`,
      "Download GitHub Actions job log",
      60000,
    );
    logCode = downloaded.exitCode ?? -1;
    logStderr = (await project(downloaded.stderr.text, 4000, 1000)).text;
    if (logCode === 0) {
      const bounded = await run(
        `bytes=$(wc -c < ${q(rawPath)}); lines=$(wc -l < ${q(rawPath)}); if [ "$bytes" -gt 4000000 ]; then tail -c 4000000 ${q(rawPath)} | sed '1d'; else cat -- ${q(rawPath)}; fi | tail -n 20000 > ${q(boundedPath)}; printf '%s %s' "$bytes" "$lines"`,
        "Bound GitHub Actions job log",
      );
      if (bounded.exitCode !== 0) throw new Error("Could not bound GitHub Actions job log");
      const [byteText, lineText] = bounded.stdout.text.trim().split(/\s+/, 2);
      const byteCount = Number(byteText);
      const lineCount = Number(lineText);
      sourceTruncated =
        (Number.isFinite(byteCount) && byteCount > 4000000) ||
        (Number.isFinite(lineCount) && lineCount > 20000);
      const content = await tools.read({ file_path: boundedPath, limit: 20000 });
      logLines = content.lines.map((line) => line.text);
      sourceTruncated ||= content.totalLines > content.lines.length;
    }
  } finally {
    await run(`rm -rf -- ${q(logDir)}`, "Remove temporary CI log directory");
  }
  const logPattern =
    /FAIL|Failed Tests|AssertionError|Test timed out|Process completed|SIGKILL|timed out|Source-shape|Source architecture|grew by|adds JavaScript|NEMOCLAW_|npm audit report|docs-review|Documentation writer|Fern validation|check-docs|hadolint|shellcheck|Nemotron/i;
  const selectedIndexes = new Set();
  let matchedLines = 0;
  for (let index = 0; index < logLines.length; index += 1) {
    if (!logPattern.test(logLines[index])) continue;
    matchedLines += 1;
    const first = Math.max(0, index - 20);
    const last = Math.min(logLines.length - 1, index + 20);
    for (let contextIndex = first; contextIndex <= last; contextIndex += 1)
      selectedIndexes.add(contextIndex);
  }
  const selectedLines = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => logLines[index]);
  const projected = await tools.project_diagnostic_text({
    lines: selectedLines,
    clipMode,
    maxLines,
    maxCharacters: 4000000,
    maxLineCharacters: 4000,
    sourceTruncated,
  });
  const candidateText = projected.text;
  let boundedText = candidateText;
  if (boundedText.length > 40000) {
    if (clipMode === "head") boundedText = boundedText.slice(0, 40000);
    else boundedText = boundedText.slice(-40000);
  }
  const boundedLines = boundedText ? boundedText.split("\n") : [];
  const lineClipped = projected.lineClipped;
  const perLineClipped = projected.lineCharacterClipped;
  const byteClipped = boundedText.length < candidateText.length;
  const truncated = projected.sourceTruncated || lineClipped || perLineClipped || byteClipped;
  const log = {
    jobId,
    repo,
    pattern: "NemoClaw CI failure signatures",
    code: logCode,
    truncated,
    truncationNotice: truncated
      ? "TRUNCATED OUTPUT: do not assume omitted log lines are irrelevant or absent."
      : null,
    truncationReasons: [
      ...(sourceTruncated ? ["source-log-bounded-before-filtering"] : []),
      ...(lineClipped ? ["selected-lines-exceeded-maxLines"] : []),
      ...(perLineClipped ? ["selected-line-exceeded-4000-characters"] : []),
      ...(byteClipped ? ["selected-text-exceeded-40000-characters"] : []),
    ],
    clipMode,
    maxLines,
    selectedLines: selectedLines.length,
    returnedLines: boundedLines.length,
    omittedLines: Math.max(0, selectedLines.length - boundedLines.length),
    matchedLines,
    stdout: boundedText,
    stderr: logStderr,
  };
  let artifact = null;
  if (artifactName) {
    try {
      const artifacts = [];
      let artifactTotal = null;
      for (let page = 1; page <= 20; page += 1) {
        const inventoryResult = await github([
          "api",
          "--include",
          `repos/${repo}/actions/runs/${job.runId}/artifacts?per_page=100&page=${page}`,
        ]);
        const boundary = inventoryResult.stdout.search(/\r?\n\r?\n/u);
        if (boundary < 0) throw new Error("Artifact inventory response omitted headers");
        const separatorLength = inventoryResult.stdout.slice(boundary).startsWith("\r\n\r\n")
          ? 4
          : 2;
        const headers = inventoryResult.stdout.slice(0, boundary);
        const inventory = JSON.parse(inventoryResult.stdout.slice(boundary + separatorLength));
        if (
          !inventory ||
          typeof inventory !== "object" ||
          Array.isArray(inventory) ||
          !Number.isSafeInteger(inventory.total_count) ||
          inventory.total_count < 0 ||
          !Array.isArray(inventory.artifacts) ||
          inventory.artifacts.some(
            (entry) => entry === null || typeof entry !== "object" || Array.isArray(entry),
          )
        )
          throw new Error("Artifact inventory page is malformed");
        if (artifactTotal === null) artifactTotal = inventory.total_count;
        else if (artifactTotal !== inventory.total_count)
          throw new Error("Artifact inventory changed during pagination");
        if (artifacts.length + inventory.artifacts.length > 2000)
          throw new Error("Artifact inventory exceeds the 2000-item inspection limit");
        artifacts.push(...inventory.artifacts);
        const hasNext = /^link:.*rel="next"/imu.test(headers);
        if (!hasNext) break;
        if (page === 20)
          throw new Error("Artifact inventory pagination exceeds the 20-page inspection limit");
      }
      if (artifactTotal === null || artifacts.length !== artifactTotal)
        throw new Error("Artifact inventory pagination was incomplete");
      const found = artifacts.find((entry) => entry.name === artifactName);
      if (!found) throw new Error(`Artifact ${artifactName} was not found for run ${job.runId}`);
      const sizeBytes = found.size_in_bytes;
      if (
        typeof sizeBytes !== "number" ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 0 ||
        sizeBytes > 25000000
      )
        throw new Error(
          `Artifact ${artifactName} has an invalid size or is too large for bounded inspection`,
        );
      const temp = await run(
        'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-ci-triage.XXXXXX"',
        "Create temporary artifact directory",
      );
      if (temp.exitCode !== 0) throw new Error("Could not create temporary artifact directory");
      const dir = temp.stdout.text.trim();
      if (!dir) throw new Error("Could not create temporary artifact directory");
      try {
        const artifactId = found.id;
        if (typeof artifactId !== "number" || !Number.isSafeInteger(artifactId) || artifactId <= 0)
          throw new Error(`Artifact ${artifactName} has an invalid artifact ID`);
        const archive = dir + "/artifact.zip";
        const download = await run(
          `output=${q(archive)}; metadata=${q(archive + ".stream")}; umask 077; set +e; set -o pipefail; gh api ${q(`repos/${repo}/actions/artifacts/${artifactId}/zip`)} | { : > "$output" || exit 1; dd bs=65536 count=381 iflag=fullblock status=none >> "$output"; full_status=$?; dd bs=1 count=30784 iflag=fullblock status=none >> "$output"; remainder_status=$?; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); bytes=$(stat -c %s -- "$output") || exit 1; state=ok; if [ -n "$extra" ]; then state=limit; elif [ "$full_status" -ne 0 ] || [ "$remainder_status" -ne 0 ]; then state=reader; fi; printf '%s %s\n' "$state" "$bytes" > "$metadata"; }; statuses=("\${PIPESTATUS[@]}"); read -r state bytes < "$metadata" || state=reader; rm -f -- "$metadata"; printf '%s %s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$state" "$bytes"`,
          "Download selected artifact ZIP",
          60000,
        );
        const [downloadStatus, readerStatus, downloadState, downloadBytesText] =
          download.stdout.text.trim().split(/\s+/, 4);
        const downloadBytes = Number(downloadBytesText);
        if (downloadState === "limit")
          throw new Error("Selected artifact compressed stream exceeds the 25,000,000-byte limit");
        if (
          download.exitCode !== 0 ||
          downloadStatus !== "0" ||
          readerStatus !== "0" ||
          downloadState !== "ok" ||
          !Number.isSafeInteger(downloadBytes) ||
          downloadBytes !== sizeBytes
        )
          throw new Error("Could not download selected artifact");
        const checked = await run(
          `archive=${q(archive)}; expected=${q(sizeBytes)}; measured=$(stat -c %s -- "$archive") || { printf 'malformed\n'; exit 0; }; if [ "$measured" -gt 25000000 ] || [ "$measured" -ne "$expected" ]; then printf 'compressed-size\n'; exit 0; fi; summary=$(LC_ALL=C zipinfo -t "$archive" 2>/dev/null) || { printf 'malformed\n'; exit 0; }; if [[ "$summary" == *$'\n'* ]] || [[ ! "$summary" =~ ^([0-9]+)[[:space:]]files?,[[:space:]]([0-9]+)[[:space:]]bytes[[:space:]]uncompressed, ]]; then printf 'malformed\n'; exit 0; fi; entries=\${BASH_REMATCH[1]}; expanded=\${BASH_REMATCH[2]}; if [ "$entries" -gt 100 ]; then printf 'entries\n'; exit 0; fi; if [ "$expanded" -gt 100000000 ]; then printf 'expanded\n'; exit 0; fi; listing=$(umask 077; mktemp "${dir}/zip-listing.XXXXXXXXXX") || { printf 'malformed\n'; exit 0; }; names=$(umask 077; mktemp "${dir}/zip-names.XXXXXXXXXX") || { rm -f -- "$listing"; printf 'malformed\n'; exit 0; }; trap 'rm -f -- "$listing" "$names"' EXIT; LC_ALL=C zipinfo -l "$archive" > "$listing" 2>/dev/null || { printf 'malformed\n'; exit 0; }; LC_ALL=C zipinfo -1 "$archive" > "$names" 2>/dev/null || { printf 'malformed\n'; exit 0; }; listing_bytes=$(wc -c < "$listing") || { printf 'malformed\n'; exit 0; }; if [ "$listing_bytes" -gt 7000000 ]; then printf 'listing\n'; exit 0; fi; state=$(awk -v expected="$entries" 'NR==FNR { exact[FNR]=$0; next } BEGIN { count=0; state="ok" } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { count++; mode=substr($0,1,1); size=$4; line=$0; for (i=1;i<=9;i++) sub(/^[^[:space:]]+[[:space:]]+/, "", line); name=exact[count]; if (line != name || name ~ /^[[:space:]]/ || name ~ /[[:space:]]$/) state="path"; if (mode != "-" && mode != "d") state="type"; if (size !~ /^[0-9]+$/) state="parser"; if (name == "" || name ~ /^[-\/]/ || name ~ /\\/ || name ~ /[[:cntrl:]]/ || name ~ /\\^[A-Z@[]/ || name ~ /[*?[[]/) state="path"; parts=split(name, component, "/"); last=parts; if (mode == "d" && component[parts] == "") last--; else if (component[parts] == "") state="path"; for (i=1;i<=last;i++) if (component[i] == "" || component[i] == "." || component[i] == "..") state="path"; output=name; sub(/\/$/, "", output); if (output == "" || seen[output]++) state="duplicate"; next } /^[0-9]+ files?, [0-9]+ bytes uncompressed, / { summaries++; next } { state="parser" } END { if (count != expected || summaries != 1) state="parser"; print state }' "$names" "$listing"); if [ "$state" != ok ]; then printf '%s\n' "$state"; exit 0; fi; unzip -tqq "$archive" >/dev/null 2>&1 || { printf 'malformed\n'; exit 0; }; selected=$(umask 077; mktemp "${dir}/selected.XXXXXXXXXX") || { printf 'malformed\n'; exit 0; }; unsorted=$(umask 077; mktemp "${dir}/unsorted.XXXXXXXXXX") || { printf 'malformed\n'; exit 0; }; trap 'rm -f -- "$listing" "$names" "$selected" "$unsorted"' EXIT; count=$(awk -v selected="$unsorted" 'NR==FNR { exact[FNR]=$0; next } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { entry++; name=exact[entry]; if (substr($0, 1, 1) == "-" && name ~ /[.]result[.]json$/) { printf "%s\t%s%c", name, $4, 0 > selected; count++ } } END { print count+0 }' "$names" "$listing") || { printf 'parser\n'; exit 0; }; LC_ALL=C sort -z "$unsorted" > "$selected" || { printf 'parser\n'; exit 0; }; encoded=$(base64 -w0 < "$selected") || { printf 'parser\n'; exit 0; }; printf 'ok %s %s\n' "$count" "$encoded"`,
          "Inspect selected artifact ZIP",
        );
        const parts = checked.stdout.text.trim().split(/\s+/, 3);
        const archiveState = parts[0];
        if (checked.exitCode !== 0 || archiveState !== "ok") {
          const details = {
            "compressed-size": "Artifact compressed size is invalid or differs from its metadata",
            entries: "Artifact contains more than 100 entries",
            expanded: "Artifact declares more than 100,000,000 expanded bytes",
            type: "Artifact contains a symlink or another unsupported entry type",
            path: "Artifact contains an unsafe, ambiguous, or option-like path",
            duplicate: "Artifact contains duplicate output paths",
            listing: "Artifact entry listing exceeds the inspection limit",
            parser: "Artifact entry listing is ambiguous",
            malformed: "Artifact ZIP is malformed",
          };
          throw new Error(details[archiveState] ?? "Could not inspect artifact ZIP");
        }
        const selectedCount = Number(parts[1]);
        const resultEntries = Buffer.from(parts[2] ?? "", "base64")
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        if (
          !Number.isSafeInteger(selectedCount) ||
          selectedCount < 0 ||
          selectedCount > 100 ||
          resultEntries.length !== selectedCount
        )
          throw new Error("Artifact result entry listing is ambiguous");
        const fileResults = [];
        let filesRead = 0;
        let measuredOutput = 0;
        let cumulativeLimitExceeded = false;
        for (let index = 0; index < resultEntries.length; index += 1) {
          const separator = resultEntries[index].lastIndexOf("\t");
          const relativePath = resultEntries[index].slice(0, separator);
          const declaredBytes = Number(resultEntries[index].slice(separator + 1));
          if (separator < 1 || !Number.isSafeInteger(declaredBytes) || declaredBytes < 0)
            throw new Error("Artifact result entry listing is ambiguous");
          if (declaredBytes > 1000000)
            throw new Error(
              `Artifact result entry ${relativePath} exceeds the 1,000,000-byte limit`,
            );
          const resultPath = dir + "/result-" + index;
          const streamed = await run(
            `archive=${q(archive)}; entry=${q(relativePath)}; output=${q(resultPath)}; metadata=${q(resultPath + ".stream")}; umask 077; set +e; set -o pipefail; unzip -p "$archive" "$entry" | { : > "$output" || exit 1; dd bs=65536 count=15 iflag=fullblock status=none >> "$output"; full_status=$?; dd bs=1 count=16960 iflag=fullblock status=none >> "$output"; remainder_status=$?; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); bytes=$(stat -c %s -- "$output") || exit 1; state=ok; if [ -n "$extra" ]; then state=limit; elif [ "$full_status" -ne 0 ] || [ "$remainder_status" -ne 0 ]; then state=reader; fi; printf '%s %s\n' "$state" "$bytes" > "$metadata"; }; statuses=("\${PIPESTATUS[@]}"); read -r state bytes < "$metadata" || state=reader; rm -f -- "$metadata"; printf '%s %s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$state" "$bytes"`,
            "Stream bounded test result artifact",
          );
          const [unzipStatus, readerStatus, streamState, byteText] = streamed.stdout.text
            .trim()
            .split(/\s+/, 4);
          if (streamState === "limit")
            throw new Error(
              `Artifact result entry ${relativePath} exceeds the 1,000,000-byte limit`,
            );
          const resultBytes = Number(byteText);
          if (
            streamed.exitCode !== 0 ||
            readerStatus !== "0" ||
            unzipStatus !== "0" ||
            streamState !== "ok" ||
            !Number.isSafeInteger(resultBytes) ||
            resultBytes < 0
          )
            throw new Error(`Could not stream artifact result entry ${relativePath}`);
          if (resultBytes > 1000000)
            throw new Error(
              `Artifact result entry ${relativePath} exceeds the 1,000,000-byte limit`,
            );
          if (resultBytes !== declaredBytes)
            throw new Error(`Artifact result entry ${relativePath} differs from its declared size`);
          measuredOutput += resultBytes;
          if (measuredOutput > 100000000) {
            cumulativeLimitExceeded = true;
            break;
          }
          const file = await tools.read({ file_path: resultPath, limit: 2000 });
          if (file.totalLines > 2000)
            throw new Error(
              `Artifact result entry ${relativePath} exceeds the 2,000-line read limit`,
            );
          const value = JSON.parse(file.lines.map((line) => line.text).join("\n"));
          filesRead += 1;
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const exitCode = Number.isInteger(value.exitCode) ? value.exitCode : null;
          const signal = value.signal ? String(value.signal).slice(0, 100) : null;
          const timedOut = Boolean(value.timedOut);
          const error = value.error
            ? (await project(String(value.error), 1000, 1000)).text || null
            : null;
          const command =
            value.command == null
              ? null
              : (await project(String(value.command), 2000, 1000)).text || null;
          if (exitCode === 0 && !signal && !error && !timedOut) continue;
          if (exitCode === null && !signal && !error && !timedOut && !value.command) continue;
          fileResults.push({
            path: relativePath.slice(0, 1000),
            exitCode,
            signal,
            timedOut,
            error,
            command,
          });
        }
        if (cumulativeLimitExceeded)
          throw new Error("Artifact streamed output exceeds the 100,000,000-byte limit");
        const failures = fileResults;
        artifact = {
          name: artifactName,
          sizeBytes,
          inventoryTruncated: false,
          filesRead,
          filesTruncated: filesRead < resultEntries.length,
          failures: failures.slice(0, 20),
          failuresTruncated: failures.length > 20,
        };
      } finally {
        await run(`rm -rf -- ${q(dir)}`, "Remove temporary artifact directory");
      }
    } catch (error) {
      throw await diagnosticError(error instanceof Error ? error.message : String(error));
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
}
