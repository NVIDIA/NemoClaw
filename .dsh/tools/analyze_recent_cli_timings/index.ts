/**
 * Aggregate bounded per-test and per-file durations from recent retained NemoClaw CLI Vitest artifacts. Reject compressed artifacts above 25,000,000 bytes. Requires GNU find for bounded extracted-file inventories.
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
    artifacts.push({
      artifactId: Number(artifact.id),
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
      const directory = root + "/" + artifact.runId;
      const downloaded = await run(
        "mkdir -p " +
          quote(directory) +
          " && gh run download " +
          quote(artifact.runId) +
          " --repo " +
          quote(repo) +
          " --name " +
          quote(artifactName) +
          " --dir " +
          quote(directory),
      );
      if (downloaded.exitCode !== 0) {
        failures.push({
          runId: artifact.runId,
          detail: await project(downloaded.stderr.text || downloaded.stdout.text, 1000),
        });
        continue;
      }
      const inventory = await run(
        `inventory=$(umask 077; mktemp "\${TMPDIR:-/tmp}/nemoclaw-cli-inventory.XXXXXXXXXX") || { printf 'unsafe\n'; exit 0; }; trap 'rm -f -- "$inventory"' EXIT; set -o pipefail; find ${quote(directory)} -mindepth 1 -printf '%y %s\0' 2>/dev/null | head -z -n 101 > "$inventory"; pipeline_status=$?; awk -v pipeline_status="$pipeline_status" 'BEGIN { RS="\0"; records=0; bytes=0; state="ok" } NF { records++; if (records == 101) { state="files"; next } if ($1 == "d") next; if ($1 != "f" || $2 !~ /^[0-9]+$/) { state="unsafe"; next } bytes += $2; if (bytes > 100000000 && state == "ok") state="bytes" } END { if (records == 101) print "files"; else if (pipeline_status != 0) print "unsafe"; else print state }' "$inventory"`,
        30000,
      );
      const inventoryState = inventory.stdout.text.trim().split(/\s+/, 1)[0];
      if (inventory.exitCode !== 0 || inventoryState !== "ok") {
        const detail =
          inventoryState === "files"
            ? "Artifact contains more than 100 regular files"
            : inventoryState === "bytes"
              ? "Artifact contains more than 100,000,000 extracted bytes"
              : "Artifact contains a symlink or another unsupported entry";
        failures.push({ runId: artifact.runId, detail });
        continue;
      }
      const matches = await tools.glob({ pattern: "**/vitest-results.json", path: directory });
      if (matches.paths.length !== 1) {
        failures.push({
          runId: artifact.runId,
          detail: `Expected one vitest-results.json file, found ${matches.paths.length}`,
        });
        continue;
      }
      const report = await tools.read({ file_path: matches.paths[0], limit: 2000 });
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
