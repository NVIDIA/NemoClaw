/**
 * Aggregate bounded per-test and per-file durations from recent retained NemoClaw CLI Vitest artifacts. Reject compressed artifacts above 25,000,000 bytes. Requires Bash, GNU dd and find, Info-ZIP zipinfo and unzip, awk, base64, mktemp, stat, and wc on Linux.
 */
export default async function analyze_recent_cli_timings(input: {
  workdir: string;
  repo?: string;
  limit?: Integer;
  top?: Integer;
  minSampleRatio?: number;
  artifactName?: string;
}): Promise<{
  repo: string;
  artifactName: string;
  reportsRequested: Integer;
  reportsFound: Integer;
  reportsAnalyzed: Integer;
  downloadFailures: { runId: Integer; detail: string }[];
  minSamples: Integer;
  runs: {
    runId: Integer;
    createdAt: string;
    headSha: string;
    totalTests: Integer;
    testFiles: Integer;
  }[];
  slowTests: {
    file: string;
    name: string;
    samples: Integer;
    medianMs: number;
    p90Ms: number;
    minMs: number;
    maxMs: number;
  }[];
  slowFiles: {
    file: string;
    samples: Integer;
    medianWallMs: number;
    p90WallMs: number;
    maxWallMs: number;
  }[];
}> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  const artifactName = input.artifactName ?? "cli-vitest-results";
  const limit = input.limit ?? 10;
  const top = input.top ?? 15;
  const ratio = input.minSampleRatio ?? 0.7;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(artifactName))
    throw new Error("artifactName contains unsupported characters");
  if (!Number.isInteger(limit) || limit < 2 || limit > 20)
    throw new Error("limit must be an integer from 2 through 20");
  if (!Number.isInteger(top) || top < 1 || top > 50)
    throw new Error("top must be an integer from 1 through 50");
  if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 1)
    throw new Error("minSampleRatio must be from 0.5 through 1");
  const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const project = async (value, maxCharacters, clipMode = "tail") =>
    (
      await tools.project_diagnostic_text({
        lines: [String(value)],
        clipMode,
        maxLines: 1,
        maxCharacters,
        maxLineCharacters: maxCharacters,
      })
    ).text;
  const accessFailures = [
    "authentication",
    "authorization",
    "forbidden",
    "not authorized",
    "http 401",
    "http 403",
    "resource not accessible",
    "sso",
  ];
  const run = async (command, timeoutMs = 120000) => {
    const result = await tools.bash({
      command,
      workdir: input.workdir,
      description: "Read bounded CLI timing artifacts",
      timeoutMs,
    });
    if (result.kind !== "foreground") throw new Error("Unexpected background result");
    const detail = (result.stderr.text + "\n" + result.stdout.text).toLowerCase();
    if (result.exitCode !== 0 && accessFailures.some((value) => detail.includes(value)))
      throw new Error(
        "GitHub access failed; correct authentication or authorization before retrying.\n" +
          (await project(result.stderr.text, 1500)),
      );
    return result;
  };
  const perPage = Math.min(100, Math.max(30, limit * 3));
  const endpoint = `repos/${repo}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=${perPage}`;
  const listed = await tools.run_github_cli({
    workdir: input.workdir,
    args: [
      "api",
      endpoint,
      "--jq",
      "{artifacts:[.artifacts[]|{id,createdAt:.created_at,expired,size:.size_in_bytes,runId:.workflow_run.id,headSha:.workflow_run.head_sha}]}",
    ],
    timeoutMs: 60000,
  });
  let artifactData;
  try {
    artifactData = JSON.parse(listed.stdout);
  } catch {
    throw new Error("Could not parse bounded artifact listing");
  }
  const seen = new Set();
  const artifacts = [];
  const failures = [];
  for (const artifact of artifactData.artifacts ?? []) {
    const runId = Number(artifact.runId ?? 0);
    if (!runId || artifact.expired || seen.has(runId)) continue;
    seen.add(runId);
    const size = artifact.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 25000000) {
      failures.push({
        runId,
        detail: "Artifact has an invalid compressed size or exceeds the 25,000,000-byte limit",
      });
      continue;
    }
    const artifactId = Number(artifact.id);
    if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
      failures.push({ runId, detail: "Artifact has an invalid artifact ID" });
      continue;
    }
    artifacts.push({
      artifactId,
      runId,
      createdAt: String(artifact.createdAt),
      headSha: String(artifact.headSha),
      size,
    });
    if (artifacts.length >= limit) break;
  }
  if (artifacts.length < 2)
    throw new Error(`Found ${artifacts.length} eligible retained reports; at least 2 are required`);
  const temporary = await run(
    'umask 077; mktemp -d "${TMPDIR:-/tmp}/nemoclaw-cli-timings.XXXXXXXXXX"',
    30000,
  );
  if (temporary.exitCode !== 0) throw new Error("Could not create private temporary directory");
  const root = temporary.stdout.text.trim();
  if (!root) throw new Error("Could not create private temporary directory");
  const reports = [];
  try {
    for (const artifact of artifacts) {
      const archive = root + "/" + artifact.runId + ".zip";
      const downloaded = await run(
        `output=${quote(archive)}; metadata=${quote(archive + ".stream")}; umask 077; set +e; set -o pipefail; gh api ${quote(`repos/${repo}/actions/artifacts/${artifact.artifactId}/zip`)} | { : > "$output" || exit 1; dd bs=65536 count=381 iflag=fullblock status=none >> "$output"; full_status=$?; dd bs=1 count=30784 iflag=fullblock status=none >> "$output"; remainder_status=$?; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); bytes=$(stat -c %s -- "$output") || exit 1; state=ok; if [ -n "$extra" ]; then state=limit; elif [ "$full_status" -ne 0 ] || [ "$remainder_status" -ne 0 ]; then state=reader; fi; printf '%s %s\n' "$state" "$bytes" > "$metadata"; }; statuses=("\${PIPESTATUS[@]}"); read -r state bytes < "$metadata" || state=reader; rm -f -- "$metadata"; printf '%s %s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$state" "$bytes"`,
      );
      const [downloadStatus, downloadReaderStatus, downloadState, downloadBytesText] =
        downloaded.stdout.text.trim().split(/\s+/, 4);
      const downloadBytes = Number(downloadBytesText);
      if (
        downloadState === "limit" ||
        downloaded.exitCode !== 0 ||
        downloadStatus !== "0" ||
        downloadReaderStatus !== "0" ||
        downloadState !== "ok" ||
        !Number.isSafeInteger(downloadBytes) ||
        downloadBytes !== artifact.size
      ) {
        failures.push({
          runId: artifact.runId,
          detail:
            downloadState === "limit"
              ? "Artifact compressed stream exceeds the 25,000,000-byte limit"
              : await project(downloaded.stderr.text || downloaded.stdout.text, 1000),
        });
        continue;
      }
      const checked = await run(
        `archive=${quote(archive)}; expected=${quote(artifact.size)}; measured=$(stat -c %s -- "$archive") || { printf 'malformed\n'; exit 0; }; if [ "$measured" -gt 25000000 ] || [ "$measured" -ne "$expected" ]; then printf 'compressed-size\n'; exit 0; fi; summary=$(LC_ALL=C zipinfo -t "$archive" 2>/dev/null) || { printf 'malformed\n'; exit 0; }; if [[ "$summary" == *$'\n'* ]] || [[ ! "$summary" =~ ^([0-9]+)[[:space:]]files?,[[:space:]]([0-9]+)[[:space:]]bytes[[:space:]]uncompressed, ]]; then printf 'malformed\n'; exit 0; fi; entries=\${BASH_REMATCH[1]}; expanded=\${BASH_REMATCH[2]}; if [ "$entries" -gt 100 ]; then printf 'entries\n'; exit 0; fi; if [ "$expanded" -gt 100000000 ]; then printf 'expanded\n'; exit 0; fi; listing=$(umask 077; mktemp "${root}/zip-listing.XXXXXXXXXX") || { printf 'malformed\n'; exit 0; }; names=$(umask 077; mktemp "${root}/zip-names.XXXXXXXXXX") || { rm -f -- "$listing"; printf 'malformed\n'; exit 0; }; trap 'rm -f -- "$listing" "$names"' EXIT; LC_ALL=C zipinfo -l "$archive" > "$listing" 2>/dev/null || { printf 'malformed\n'; exit 0; }; LC_ALL=C zipinfo -1 "$archive" > "$names" 2>/dev/null || { printf 'malformed\n'; exit 0; }; listing_bytes=$(wc -c < "$listing") || { printf 'malformed\n'; exit 0; }; if [ "$listing_bytes" -gt 7000000 ]; then printf 'listing\n'; exit 0; fi; state=$(awk -v expected="$entries" 'NR==FNR { exact[FNR]=$0; next } BEGIN { count=0; state="ok" } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { count++; mode=substr($0,1,1); size=$4; line=$0; for (i=1;i<=9;i++) sub(/^[^[:space:]]+[[:space:]]+/, "", line); name=exact[count]; if (line != name || name ~ /^[[:space:]]/ || name ~ /[[:space:]]$/) state="path"; if (mode != "-" && mode != "d") state="type"; if (size !~ /^[0-9]+$/) state="parser"; if (name == "" || name ~ /^[-\/]/ || name ~ /\\/ || name ~ /[[:cntrl:]]/ || name ~ /\\^[A-Z@[]/ || name ~ /[*?[[]/) state="path"; parts=split(name, component, "/"); last=parts; if (mode == "d" && component[parts] == "") last--; else if (component[parts] == "") state="path"; for (i=1;i<=last;i++) if (component[i] == "" || component[i] == "." || component[i] == "..") state="path"; output=name; sub(/\/$/, "", output); if (output == "" || seen[output]++) state="duplicate"; next } /^[0-9]+ files?, [0-9]+ bytes uncompressed, / { summaries++; next } { state="parser" } END { if (count != expected || summaries != 1) state="parser"; print state }' "$names" "$listing"); if [ "$state" != ok ]; then printf '%s\n' "$state"; exit 0; fi; unzip -tqq "$archive" >/dev/null 2>&1 || { printf 'malformed\n'; exit 0; }; selected=$(umask 077; mktemp "${root}/selected.XXXXXXXXXX") || { printf 'malformed\n'; exit 0; }; trap 'rm -f -- "$listing" "$names" "$selected"' EXIT; count=$(awk -v selected="$selected" 'NR==FNR { exact[FNR]=$0; next } FNR <= 2 { next } /^[bcdlps-][rwxStTs-]{9}[[:space:]]/ { entry++; name=exact[entry]; if (substr($0, 1, 1) == "-") { parts=split(name, component, "/"); if (component[parts] == "vitest-results.json") { printf "%s\t%s%c", $4, name, 0 > selected; count++ } } } END { print count+0 }' "$names" "$listing") || { printf 'parser\n'; exit 0; }; encoded=$(base64 -w0 < "$selected") || { printf 'parser\n'; exit 0; }; printf 'ok %s %s\n' "$count" "$encoded"`,
        30000,
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
        failures.push({
          runId: artifact.runId,
          detail: details[archiveState] ?? "Could not inspect artifact ZIP",
        });
        continue;
      }
      const count = Number(parts[1]);
      const selections = Buffer.from(parts[2] ?? "", "base64")
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      if (count !== 1 || selections.length !== 1) {
        failures.push({
          runId: artifact.runId,
          detail: `Expected one vitest-results.json file, found ${count}`,
        });
        continue;
      }
      const separator = selections[0].indexOf("\t");
      const declaredBytes = Number(selections[0].slice(0, separator));
      const entry = selections[0].slice(separator + 1);
      if (separator < 1 || !Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || !entry) {
        failures.push({ runId: artifact.runId, detail: "Artifact entry listing is ambiguous" });
        continue;
      }
      const reportPath = root + "/report-" + artifact.runId;
      const streamed = await run(
        `archive=${quote(archive)}; entry=${quote(entry)}; output=${quote(reportPath)}; metadata=${quote(reportPath + ".stream")}; umask 077; set +e; set -o pipefail; unzip -p "$archive" "$entry" | { : > "$output" || exit 1; dd bs=65536 count=1525 iflag=fullblock status=none >> "$output"; full_status=$?; dd bs=1 count=57600 iflag=fullblock status=none >> "$output"; remainder_status=$?; extra=$(dd bs=1 count=1 iflag=fullblock status=none | base64 -w0); bytes=$(stat -c %s -- "$output") || exit 1; state=ok; if [ -n "$extra" ]; then state=limit; elif [ "$full_status" -ne 0 ] || [ "$remainder_status" -ne 0 ]; then state=reader; fi; printf '%s %s\n' "$state" "$bytes" > "$metadata"; }; statuses=("\${PIPESTATUS[@]}"); read -r state bytes < "$metadata" || state=reader; rm -f -- "$metadata"; printf '%s %s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$state" "$bytes"`,
        30000,
      );
      const [unzipStatus, readerStatus, streamState, byteText] = streamed.stdout.text
        .trim()
        .split(/\s+/, 4);
      const reportBytes = Number(byteText);
      if (
        streamState === "limit" ||
        streamed.exitCode !== 0 ||
        unzipStatus !== "0" ||
        readerStatus !== "0" ||
        streamState !== "ok" ||
        !Number.isSafeInteger(reportBytes) ||
        reportBytes !== declaredBytes ||
        reportBytes > 100000000
      ) {
        failures.push({
          runId: artifact.runId,
          detail: "Could not stream bounded vitest-results.json content",
        });
        continue;
      }
      const report = await tools.read({ file_path: reportPath, limit: 2000 });
      try {
        reports.push({
          artifact,
          data: JSON.parse(report.lines.map((line) => line.text).join("\n")),
        });
      } catch {
        failures.push({ runId: artifact.runId, detail: "Could not parse vitest-results.json" });
      }
    }
    if (reports.length < 2)
      throw new Error(`Downloaded ${reports.length} usable reports; at least 2 are required`);
    reports.sort((a, b) => b.artifact.createdAt.localeCompare(a.artifact.createdAt));
    const tests = new Map();
    const files = new Map();
    const runs = [];
    const repoName = repo.split("/")[1];
    const marker = "/" + repoName + "/" + repoName + "/";
    const clean = (value) => {
      const index = value.lastIndexOf(marker);
      return index >= 0 ? value.slice(index + marker.length) : value;
    };
    for (const { artifact, data } of reports) {
      const suites = data.testResults ?? [];
      runs.push({
        runId: artifact.runId,
        createdAt: artifact.createdAt,
        headSha: artifact.headSha,
        totalTests: Number(data.numTotalTests || 0),
        testFiles: suites.length,
      });
      for (const suite of suites) {
        const file = await project(clean(String(suite.name || "")), 4000000, "head");
        const wall = Math.max(0, Number(suite.endTime || 0) - Number(suite.startTime || 0));
        files.set(file, [...(files.get(file) ?? []), wall]);
        for (const test of suite.assertionResults ?? []) {
          const duration = test.duration;
          if (typeof duration !== "number" || !Number.isFinite(duration)) continue;
          const name = String(
            test.fullName || [...(test.ancestorTitles ?? []), test.title ?? ""].join(" "),
          );
          const key = JSON.stringify([file, name]);
          tests.set(key, [...(tests.get(key) ?? []), duration]);
        }
      }
    }
    const quantile = (values, q) => {
      const sorted = [...values].sort((a, b) => a - b);
      const position = (sorted.length - 1) * q;
      const low = Math.floor(position);
      const high = Math.ceil(position);
      return low === high
        ? sorted[low]
        : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    };
    const round = (value) => Math.round(value * 10) / 10;
    const minimum = Math.max(2, Math.ceil(reports.length * ratio));
    const slowTests = [...tests.entries()]
      .filter(([, values]) => values.length >= minimum)
      .map(([key, values]) => {
        const [file, name] = JSON.parse(key);
        return {
          file,
          name,
          samples: values.length,
          medianMs: round(quantile(values, 0.5)),
          p90Ms: round(quantile(values, 0.9)),
          minMs: round(Math.min(...values)),
          maxMs: round(Math.max(...values)),
        };
      })
      .sort((a, b) => b.medianMs - a.medianMs)
      .slice(0, top);
    const slowFiles = [...files.entries()]
      .filter(([, values]) => values.length >= minimum)
      .map(([file, values]) => ({
        file,
        samples: values.length,
        medianWallMs: round(quantile(values, 0.5)),
        p90WallMs: round(quantile(values, 0.9)),
        maxWallMs: round(Math.max(...values)),
      }))
      .sort((a, b) => b.medianWallMs - a.medianWallMs)
      .slice(0, top);
    return {
      repo,
      artifactName,
      reportsRequested: limit,
      reportsFound: artifacts.length,
      reportsAnalyzed: reports.length,
      downloadFailures: failures.slice(0, 10),
      minSamples: minimum,
      runs,
      slowTests,
      slowFiles,
    };
  } finally {
    await run("rm -rf -- " + quote(root), 30000);
  }
}
