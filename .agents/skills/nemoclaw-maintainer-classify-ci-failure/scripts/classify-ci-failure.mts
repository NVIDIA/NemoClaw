// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readValidatedArtifactZipEntries } from "../../../../scripts/scorecard/read-artifact-zip.mts";

type ClipMode = "head" | "tail";
type Input = {
  workdir: string;
  jobId: number | string;
  repo?: string;
  artifactName?: string;
  maxLines?: number;
  clipMode?: ClipMode;
};
type ProcessResult = {
  kind: "foreground";
  exitCode: number;
  stdout: { text: string };
  stderr: { text: string };
};
const SECRET_ASSIGNMENT =
  /(\b(?:AWS_ACCESS_KEY_ID|[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*)\s*[=:]\s*)(?!\[REDACTED\])(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
const JSON_SECRET_FIELD =
  /("[^"\r\n]*(?:secret|token|password|api[_-]?key|authorization)[^"\r\n]*"\s*:\s*)"(?:\\.|[^"\\\r\n])*"/giu;
const STANDALONE_SECRET =
  /\b(?:(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|nv(?:api|cf)-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/gu;
const SECRET_QUERY_FIELD =
  /([?&](?:X-Amz-(?:Credential|Signature|Security-Token)|X-Goog-(?:Credential|Signature)|sig|access_token|token)=)(?!\[REDACTED\])[^&#\s"']*/giu;
const SECRET_HEADER =
  /(^|[\r\n])((?:(?:>\s*|request:\s*))?(?:x-)?api-key\s*:\s*)(?!\[REDACTED\])[^\r\n]*/giu;
const redact = (value: string): string =>
  value
    .replace(JSON_SECRET_FIELD, '$1"[REDACTED]"')
    .replace(SECRET_HEADER, "$1$2[REDACTED]")
    .replace(/(\bauthorization\s*:\s*)[^\r\n]*/giu, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@")
    .replace(SECRET_QUERY_FIELD, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(STANDALONE_SECRET, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED]");
const projectText = (input: {
  lines: string[];
  clipMode?: ClipMode;
  lineClipMode?: ClipMode;
  maxLines?: number;
  maxCharacters: number;
  maxLineCharacters: number;
  sourceTruncated?: boolean;
}) => {
  let lineCharacterClipped = false;
  const safe = input.lines.map((line) => {
    const value = redact(line);
    if (value.length <= input.maxLineCharacters) return value;
    lineCharacterClipped = true;
    return (input.lineClipMode ?? input.clipMode) === "head"
      ? value.slice(0, input.maxLineCharacters)
      : value.slice(-input.maxLineCharacters);
  });
  const maxLines = input.maxLines ?? safe.length;
  const lineClipped = safe.length > maxLines;
  const selected = lineClipped
    ? input.clipMode === "head"
      ? safe.slice(0, maxLines)
      : safe.slice(-maxLines)
    : safe;
  let text = selected.join("\n");
  const textClipped = text.length > input.maxCharacters;
  if (textClipped)
    text =
      input.clipMode === "head"
        ? text.slice(0, input.maxCharacters)
        : text.slice(-input.maxCharacters);
  return {
    text,
    sourceTruncated: Boolean(input.sourceTruncated),
    lineClipped,
    lineCharacterClipped,
    textClipped,
  };
};
type ProcessGroup = {
  pid: number;
  state: "running" | "terminating";
  drained: Promise<void>;
  markDrained: () => void;
};
const processGroups = new Map<number, ProcessGroup>();
const PROCESS_GROUP_WRAPPER = String.raw`
const { spawn } = require("node:child_process");
const { readdirSync, readFileSync } = require("node:fs");
const leader = process.pid;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
const child = spawn(process.argv[1], process.argv.slice(2), {
  stdio: ["ignore", "inherit", "inherit"],
});
let exitCode = 1;
let childExited = false;
const groupHasDescendants = () => {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === leader) continue;
    try {
      const stat = readFileSync("/proc/" + name + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === leader) return true;
    } catch {}
  }
  return false;
};
const drain = () => {
  if (!childExited || groupHasDescendants()) return;
  clearInterval(poll);
  process.exit(exitCode);
};
const poll = setInterval(drain, 10);
child.once("error", () => {
  childExited = true;
  drain();
});
child.once("exit", (code) => {
  exitCode = code ?? 1;
  childExited = true;
  drain();
});
`;
const ownsProcessGroup = (group: ProcessGroup | undefined): group is ProcessGroup =>
  group !== undefined && processGroups.get(group.pid) === group;
const markProcessGroupDrained = (group: ProcessGroup | undefined): void => {
  if (!group || !ownsProcessGroup(group)) return;
  processGroups.delete(group.pid);
  group.markDrained();
};
const beginTermination = (group: ProcessGroup | undefined): void => {
  if (!group || !ownsProcessGroup(group) || group.state === "terminating") return;
  group.state = "terminating";
  try {
    process.kill(-group.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") markProcessGroupDrained(group);
  }
};
const forceTerminatingGroup = (group: ProcessGroup | undefined): void => {
  if (!group || !ownsProcessGroup(group) || group.state !== "terminating") return;
  try {
    process.kill(-group.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") markProcessGroupDrained(group);
  }
};
export const execute = async (
  command: string,
  args: string[],
  workdir: string,
  timeoutMs: number,
): Promise<ProcessResult> => {
  temporaryDirectories.installHandlers();
  if (temporaryDirectories.shutdownStarted)
    throw new Error("Cannot execute a new process after shutdown has started");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", PROCESS_GROUP_WRAPPER, command, ...args], {
      cwd: workdir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let group: ProcessGroup | undefined;
    if (child.pid !== undefined && Number.isSafeInteger(child.pid) && child.pid > 0) {
      let markDrained = (): void => {};
      const drained = new Promise<void>((resolveDrained) => {
        markDrained = resolveDrained;
      });
      group = { pid: child.pid, state: "running", drained, markDrained };
      processGroups.set(group.pid, group);
    }
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const append = (current: string, chunk: Buffer): string => {
      const combined = current + chunk.toString("utf8");
      if (combined.length <= 8_000_000) return combined;
      overflow = true;
      return combined.slice(-8_000_000);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    let escalation: NodeJS.Timeout | undefined;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (!ownsProcessGroup(group)) return;
      timedOut = true;
      beginTermination(group);
      escalation = setTimeout(() => forceTerminatingGroup(group), 1000);
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      markProcessGroupDrained(group);
      resolve({
        kind: "foreground",
        exitCode: 1,
        stdout: { text: stdout },
        stderr: { text: stderr || error.message },
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      markProcessGroupDrained(group);
      resolve({
        kind: "foreground",
        exitCode: overflow || timedOut ? 1 : (code ?? 1),
        stdout: { text: stdout },
        stderr: {
          text: overflow
            ? `${stderr}\nProcess output exceeded the 8,000,000-character limit`
            : stderr,
        },
      });
    });
  });
};

const TEMPORARY_ROOT = `/tmp/nemoclaw-ci-classifier-${process.getuid?.() ?? "unknown"}`;
type TemporaryKind = "CI log" | "artifact";
class TemporaryDirectoryManager {
  readonly #tracked = new Set<string>();
  #handlersInstalled = false;
  #shutdownStarted = false;

  create(kind: TemporaryKind): string {
    mkdirSync(TEMPORARY_ROOT, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(TEMPORARY_ROOT);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      (rootStat.mode & 0o077) !== 0 ||
      rootStat.uid !== process.getuid?.()
    )
      throw new Error("Temporary classifier root is not a private owned directory");
    const prefix = kind === "CI log" ? "nemoclaw-ci-log." : "nemoclaw-ci-classify.";
    const dir = mkdtempSync(join(TEMPORARY_ROOT, prefix));
    this.#tracked.add(dir);
    return dir;
  }

  owns(dir: string): boolean {
    return this.#tracked.has(dir);
  }

  untrack(dir: string): void {
    this.#tracked.delete(dir);
  }

  get shutdownStarted(): boolean {
    return this.#shutdownStarted;
  }

  installHandlers(): void {
    if (this.#handlersInstalled) return;
    this.#handlersInstalled = true;
    for (const [signal, code] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const)
      process.on(signal, () => {
        if (this.#shutdownStarted) return;
        this.#shutdownStarted = true;
        void this.#shutdown(signal, code);
      });
  }

  async #shutdown(_signal: NodeJS.Signals, code: number): Promise<void> {
    const groups = [...processGroups.values()];
    for (const group of groups) beginTermination(group);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const group of groups) forceTerminatingGroup(group);
    await Promise.all(groups.map((group) => group.drained));
    for (const dir of this.#tracked) {
      try {
        rmSync(dir, { recursive: true, force: true });
        this.#tracked.delete(dir);
      } catch {
        // Cancellation cleanup is best effort; the fixed root keeps manual recovery actionable.
      }
    }
    process.exit(code);
  }
}
const temporaryDirectories = new TemporaryDirectoryManager();
const normalizeArtifactName = (value: string | undefined): string => {
  const artifactName = value?.trim() ?? "";
  if (
    value !== undefined &&
    (artifactName !== value || !/^[A-Za-z0-9_. -]{1,200}$/.test(artifactName))
  )
    throw new Error("artifactName must be a trimmed GitHub Actions artifact name");
  return artifactName;
};

// Internal trust boundary: callers select only these fixed gh, Bash, and coreutils
// operations. Artifact contents are parsed as data and are never executed. Process-group
// management therefore contains these trusted children; it is not an untrusted workload sandbox.
const runtime = {
  project_diagnostic_text: async (input: Parameters<typeof projectText>[0]) => projectText(input),
  run_github_cli: async (input: { workdir: string; args: string[]; timeoutMs: number }) => {
    const result = await execute("gh", input.args, input.workdir, input.timeoutMs);
    if (result.exitCode !== 0) throw new Error(result.stderr.text || result.stdout.text);
    return { stdout: result.stdout.text, stderr: result.stderr.text };
  },
  bash: async (input: {
    command: string;
    workdir: string;
    description?: string;
    timeoutMs: number;
  }) => execute("bash", ["-c", input.command], input.workdir, input.timeoutMs),
  read: async (input: { file_path: string; limit: number }) => {
    const lines = readFileSync(input.file_path, "utf8").split(/\r?\n/u);
    if (lines.at(-1) === "") lines.pop();
    return {
      lines: lines.slice(0, input.limit).map((text, index) => ({ number: index + 1, text })),
      totalLines: lines.length,
    };
  },
};

function selectUniqueArtifact(
  artifacts: Record<string, unknown>[],
  artifactName: string,
  runId: number,
): Record<string, unknown> {
  const matches = artifacts.filter((entry) => entry.name === artifactName);
  if (matches.length === 0)
    throw new Error(`Artifact ${artifactName} was not found for run ${runId}`);
  if (matches.length === 1) return matches[0];
  const identifiers = matches
    .slice(0, 20)
    .map((entry) =>
      typeof entry.id === "number" && Number.isSafeInteger(entry.id) && entry.id > 0
        ? String(entry.id)
        : "invalid",
    );
  const suffix = matches.length > identifiers.length ? ", ..." : "";
  throw new Error(
    `Artifact ${artifactName} is ambiguous for run ${runId}; matching artifact IDs: ${identifiers.join(", ")}${suffix}`,
  );
}

export async function classifyCiFailure(input: Input): Promise<Record<string, unknown>> {
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  const jobId = String(input.jobId);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
  if (!/^\d+$/.test(jobId) || jobId === "0")
    throw new Error("jobId must be a positive numeric GitHub Actions job ID");
  const maxLines = input.maxLines ?? 120;
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 500)
    throw new Error("maxLines must be an integer from 1 through 500");
  const clipMode = input.clipMode ?? "tail";
  if (!new Set(["head", "tail"]).has(clipMode)) throw new Error("clipMode must be head or tail");
  const artifactName = normalizeArtifactName(input.artifactName);
  const q = (value: unknown): string => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const project = async (
    value: unknown,
    maxCharacters: number,
    maxLineCharacters: number = maxCharacters,
  ) =>
    runtime.project_diagnostic_text({
      lines: [String(value)],
      clipMode: "tail",
      lineClipMode: "tail",
      maxLines: 40,
      maxCharacters,
      maxLineCharacters,
    });
  const diagnosticError = async (message: unknown): Promise<Error> => {
    const safe = redact(String(message));
    return new Error(safe.slice(0, 2000) || "Diagnostic unavailable");
  };
  const github = async (args: string[], timeoutMs = 30000) => {
    try {
      return await runtime.run_github_cli({ workdir: input.workdir, args, timeoutMs });
    } catch (error) {
      throw await diagnosticError(error instanceof Error ? error.message : String(error));
    }
  };
  const run = async (command: string, description: string, timeoutMs = 30000) => {
    const result = await runtime.bash({ command, workdir: input.workdir, description, timeoutMs });
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
  const cleanupTemporaryDirectory = async (
    dir: string,
    kind: "CI log" | "artifact",
  ): Promise<string> => {
    const generatedName = basename(dir);
    if (!temporaryDirectories.owns(dir))
      return `Cleanup failure: temporary ${kind} directory was not owned by this process`;
    const expectedPrefix = kind === "CI log" ? "nemoclaw-ci-log" : "nemoclaw-ci-classify";
    if (!new RegExp(`^${expectedPrefix}\\.[A-Za-z0-9]{6}$`, "u").test(generatedName))
      return `Cleanup failure: temporary ${kind} directory had an invalid generated name`;
    const remediationPath = q(join(TEMPORARY_ROOT, generatedName));
    const remediation = `Remove it directly with: rm -rf -- ${remediationPath}`;
    try {
      rmSync(dir, { recursive: true, force: true });
      temporaryDirectories.untrack(dir);
      return "";
    } catch (error) {
      const detail = redact(error instanceof Error ? error.message : String(error)).slice(-1000);
      return `Cleanup failure for ${q(generatedName)}: ${detail}. ${remediation}`;
    }
  };
  const appendCleanupFailure = (error: unknown, cleanupFailure: string): Error => {
    const primary = error instanceof Error ? error.message : String(error);
    return new Error(cleanupFailure ? `${primary}\n${cleanupFailure}` : primary);
  };
  const jobResult = await github(["api", `repos/${repo}/actions/jobs/${jobId}`]);
  const rawJob = JSON.parse(jobResult.stdout);
  const [jobName, jobUrl] = await Promise.all([
    project(rawJob.name ?? "", 500, 500),
    project(rawJob.html_url ?? "", 2000, 2000),
  ]);
  const job = {
    id: Number(rawJob.id ?? jobId),
    runId: Number(rawJob.run_id ?? 0),
    name: jobName.text,
    status: String(rawJob.status ?? "").slice(0, 100),
    conclusion: rawJob.conclusion == null ? null : String(rawJob.conclusion).slice(0, 100),
    url: jobUrl.text,
  };
  const logDir = temporaryDirectories.create("CI log");
  let logCode = -1;
  let logStderr = "";
  let sourceTruncated = false;
  let logLines: string[] = [];
  let logFailure: unknown;
  try {
    const rawPath = logDir + "/job.log";
    const boundedPath = logDir + "/job.tail.log";
    const downloaded = await run(
      `set +e; set -o pipefail; gh api ${q(`repos/${repo}/actions/jobs/${jobId}/logs`)} | tail -c 4000000 > ${q(rawPath)}; statuses=("\${PIPESTATUS[@]}"); bytes=$(stat -c %s -- ${q(rawPath)}) || exit 1; printf '%s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$bytes"`,
      "Stream bounded GitHub Actions job log",
      60000,
    );
    const [githubStatus, captureStatus, byteText] = downloaded.stdout.text.trim().split(/\s+/, 3);
    const byteCount = Number(byteText);
    logCode =
      downloaded.exitCode === 0 &&
      githubStatus === "0" &&
      captureStatus === "0" &&
      Number.isSafeInteger(byteCount)
        ? 0
        : Number(githubStatus) || Number(captureStatus) || downloaded.exitCode || 1;
    logStderr = (await project(downloaded.stderr.text, 4000, 1000)).text;
    if (logCode === 0) {
      const bounded = await run(
        `tail -n 20000 -- ${q(rawPath)} > ${q(boundedPath)}; lines=$(wc -l < ${q(rawPath)}); printf '%s' "$lines"`,
        "Bound GitHub Actions job log lines",
      );
      if (bounded.exitCode !== 0)
        throw await diagnosticError(
          bounded.stderr.text || "Could not bound GitHub Actions job log",
        );
      const lineCount = Number(bounded.stdout.text.trim());
      sourceTruncated =
        (Number.isFinite(byteCount) && byteCount >= 4000000) ||
        (Number.isFinite(lineCount) && lineCount > 20000);
      const content = await runtime.read({ file_path: boundedPath, limit: 20000 });
      logLines = content.lines.map((line) => line.text);
      sourceTruncated ||= content.totalLines > content.lines.length;
    }
  } catch (error) {
    logFailure = error;
  }
  const logCleanupFailure = await cleanupTemporaryDirectory(logDir, "CI log");
  if (logFailure !== undefined) throw appendCleanupFailure(logFailure, logCleanupFailure);
  if (logCleanupFailure) {
    const primary =
      logCode === 0 ? undefined : logStderr || `GitHub Actions log read failed (exit ${logCode})`;
    throw appendCleanupFailure(primary ?? logCleanupFailure, primary ? logCleanupFailure : "");
  }
  const logPattern =
    /FAIL|Failed Tests|AssertionError|Test timed out|Process completed|SIGKILL|timed out|Source-shape|Source architecture|grew by|adds JavaScript|NEMOCLAW_|npm audit report|docs-review|Documentation writer|Fern validation|check-docs|hadolint|shellcheck|Nemotron/i;
  const selectedIndexes = new Set<number>();
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
  const projected = await runtime.project_diagnostic_text({
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
      const artifacts: Record<string, unknown>[] = [];
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
            (entry: unknown) => entry === null || typeof entry !== "object" || Array.isArray(entry),
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
      const found = selectUniqueArtifact(artifacts, artifactName, job.runId);
      const artifactId = found.id;
      if (typeof artifactId !== "number" || !Number.isSafeInteger(artifactId) || artifactId <= 0)
        throw new Error(`Artifact ${artifactName} has an invalid artifact ID`);
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
      const dir = temporaryDirectories.create("artifact");
      let artifactFailure: unknown;
      try {
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
        const archiveBytes = readFileSync(archive);
        if (archiveBytes.length !== sizeBytes)
          throw new Error("Artifact compressed size differs from its metadata");
        const entries = readValidatedArtifactZipEntries(archiveBytes, {
          maxEntries: 100,
          maxTotalUncompressedBytes: 100_000_000,
        });
        if (entries === null) throw new Error("Artifact ZIP is malformed or unsafe");
        const resultEntries = entries.filter(({ name }) => name.endsWith(".result.json"));
        const fileResults = [];
        let filesRead = 0;
        for (const { name: relativePath, bytes: contents } of resultEntries) {
          if (contents.length > 1_000_000)
            throw new Error(
              `Artifact result entry ${redact(relativePath).slice(0, 1000)} is invalid or exceeds the 1,000,000-byte limit`,
            );
          const text = contents.toString("utf8");
          const lineCount = text === "" ? 0 : text.split(/\r?\n/u).length;
          if (lineCount > 2_000)
            throw new Error(
              `Artifact result entry ${redact(relativePath).slice(0, 1000)} exceeds the 2,000-line read limit`,
            );
          filesRead += 1;
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            continue;
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const result = value as Record<string, unknown>;
          const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
          const signal =
            typeof result.signal === "string" && Object.hasOwn(osConstants.signals, result.signal)
              ? result.signal
              : null;
          const timedOut = Boolean(result.timedOut);
          const error = result.error
            ? (await project(String(result.error), 1000, 1000)).text || null
            : null;
          const command =
            result.command == null
              ? null
              : (await project(String(result.command), 2000, 1000)).text || null;
          if (exitCode === 0 && !signal && !error && !timedOut) continue;
          if (exitCode === null && !signal && !error && !timedOut && !result.command) continue;
          fileResults.push({
            path: redact(relativePath).slice(0, 1000),
            exitCode,
            signal,
            timedOut,
            error,
            command,
          });
        }
        artifact = {
          name: artifactName,
          artifactId,
          sizeBytes,
          inventoryTruncated: false,
          filesRead,
          filesTruncated: filesRead < resultEntries.length,
          failures: fileResults.slice(0, 20),
          failuresTruncated: fileResults.length > 20,
        };
      } catch (error) {
        artifactFailure = error;
      }
      const artifactCleanupFailure = await cleanupTemporaryDirectory(dir, "artifact");
      if (artifactFailure !== undefined)
        throw appendCleanupFailure(artifactFailure, artifactCleanupFailure);
      if (artifactCleanupFailure) throw new Error(artifactCleanupFailure);
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
  const findings: { type: string; detail: string; suggestion: string }[] = [];
  const add = (type: string, detail: string, suggestion: string): void => {
    findings.push({ type, detail: detail.slice(0, 4000), suggestion: suggestion.slice(0, 1000) });
  };
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

function parseArguments(args: string[]): Input {
  const values: Record<string, string> = {};
  const allowed = new Set(["workdir", "job-id", "repo", "artifact-name", "max-lines", "clip-mode"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error("Arguments must use --name value pairs");
    const name = key.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option --${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate option --${name}`);
    values[name] = value;
  }
  if (!values["job-id"]) throw new Error("--job-id is required");
  if (
    values["max-lines"] !== undefined &&
    !/^(?:[1-9]|[1-9]\d|[1-4]\d{2}|500)$/u.test(values["max-lines"])
  )
    throw new Error("--max-lines must be an integer from 1 through 500");
  return {
    workdir: values.workdir ?? process.cwd(),
    jobId: values["job-id"],
    repo: values.repo,
    artifactName: values["artifact-name"],
    maxLines: values["max-lines"] ? Number(values["max-lines"]) : undefined,
    clipMode: values["clip-mode"] as ClipMode | undefined,
  };
}
async function main(): Promise<void> {
  console.log(
    JSON.stringify(await classifyCiFailure(parseArguments(process.argv.slice(2))), null, 2),
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
