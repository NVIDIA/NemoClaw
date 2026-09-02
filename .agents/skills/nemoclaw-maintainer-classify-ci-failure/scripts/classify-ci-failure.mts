// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readValidatedArtifactZipEntries } from "../../../../scripts/lib/read-artifact-zip.mts";

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
  timedOut: boolean;
  stdout: { text: string };
  stderr: { text: string };
};
type ArtifactResult = {
  path: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
};
const artifactResultRank = (result: ArtifactResult): number => {
  if (result.signal) return 4;
  if (result.timedOut) return 3;
  if (result.error) return 2;
  if (result.exitCode !== null) return 1;
  return 0;
};
const selectArtifactWinner = (
  current: ArtifactResult | null,
  candidate: ArtifactResult,
): ArtifactResult =>
  current && artifactResultRank(current) >= artifactResultRank(candidate) ? current : candidate;
const addArtifactFinding = (
  failure: ArtifactResult | null,
  add: (type: string, detail: string, suggestion: string) => void,
): void => {
  if (failure?.signal)
    add(
      "process-signal",
      `Captured command ${failure.path} ended with ${failure.signal}.`,
      "Inspect timeout and resource evidence before changing behavior or retrying the same commit.",
    );
  else if (failure?.timedOut)
    add(
      "process-timeout",
      `Captured command ${failure.path} exceeded its time limit.`,
      "Inspect the captured command and surrounding resource evidence before changing its timeout or retrying.",
    );
  else if (failure?.error)
    add(
      "artifact-reported-error",
      `Captured command ${failure.path} reported: ${failure.error}`,
      "Inspect the reported command error and its producing step before retrying the same commit.",
    );
  else if (failure?.exitCode !== null && failure?.exitCode !== undefined && failure.exitCode !== 0)
    add(
      "process-exit-code",
      `Captured command ${failure.path} exited with code ${failure.exitCode}.`,
      "Inspect the captured command and its producing step for the first actionable diagnostic.",
    );
};
export type ClassifierExecutablePaths = {
  bash: string;
  dd: string;
  gh: string;
  stat: string;
  tail: string;
  wc: string;
};
export type ClassifierRuntime = {
  executables: ClassifierExecutablePaths;
  environment: NodeJS.ProcessEnv;
  timeouts?: {
    metadataMs?: number;
    logMs?: number;
    artifactMs?: number;
  };
};
const SYSTEM_EXECUTABLES = {
  bash: "/usr/bin/bash",
  dd: "/usr/bin/dd",
  stat: "/usr/bin/stat",
  tail: "/usr/bin/tail",
  wc: "/usr/bin/wc",
} as const;

type TrustedExecutableStat = {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  mode: number;
  uid: number;
};
export type GhResolverFilesystem = {
  lstat: (path: string) => TrustedExecutableStat;
  realpath: (path: string) => string;
  access: (path: string, mode: number) => void;
};
const PRODUCTION_GH_FILESYSTEM: GhResolverFilesystem = {
  lstat: lstatSync,
  realpath: realpathSync,
  access: accessSync,
};
const trustedPathComponents = (root: string, path: string): string[] => {
  const components = [root];
  let current = root;
  for (const component of relative(root, path).split("/").filter(Boolean)) {
    current = join(current, component);
    components.push(current);
  }
  return components;
};
const isInside = (root: string, path: string): boolean => {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith("../") && remainder !== "..");
};
const validateTrustedPath = (
  path: string,
  trustedRoot: string,
  uid: number,
  filesystem: GhResolverFilesystem,
): string => {
  const canonicalRoot = filesystem.realpath(trustedRoot);
  if (canonicalRoot !== trustedRoot)
    throw new Error("Trusted executable root is a symlink: " + trustedRoot);
  for (const component of trustedPathComponents("/", trustedRoot)) {
    const stat = filesystem.lstat(component);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
      throw new Error("Trusted executable root has an unsafe component: " + component);
    if (stat.uid !== 0 && stat.uid !== uid)
      throw new Error("Trusted executable root has an unsafe owner: " + component);
  }
  const candidateStat = filesystem.lstat(path);
  if (candidateStat.isSymbolicLink())
    throw new Error("GitHub CLI candidate must not be a symlink: " + path);
  const canonicalPath = filesystem.realpath(path);
  if (!isInside(canonicalRoot, canonicalPath))
    throw new Error("GitHub CLI resolves outside its trusted root: " + path);
  for (const component of trustedPathComponents(canonicalRoot, canonicalPath)) {
    const stat = filesystem.lstat(component);
    const isLast = component === canonicalPath;
    if ((stat.mode & 0o022) !== 0 || stat.isSymbolicLink())
      throw new Error("GitHub CLI path has an unsafe component: " + component);
    if (stat.uid !== 0 && stat.uid !== uid)
      throw new Error("GitHub CLI path has an unsafe owner: " + component);
    if ((isLast && !stat.isFile()) || (!isLast && !stat.isDirectory()))
      throw new Error("GitHub CLI path component has an unsafe type: " + component);
  }
  filesystem.access(canonicalPath, fsConstants.X_OK);
  return canonicalPath;
};

/** @internal Test seam for the production GitHub CLI trust policy. */
export function resolveProductionGhExecutableForTest(
  environment: NodeJS.ProcessEnv,
  uid: number = process.getuid?.() ?? -1,
  filesystem: GhResolverFilesystem = PRODUCTION_GH_FILESYSTEM,
): string {
  const roots = ["/usr/bin", "/usr/local/bin"];
  const home = environment.HOME;
  if (home !== undefined) {
    if (!isAbsolute(home) || resolve(home) !== home)
      throw new Error("HOME must be an absolute normalized path");
    roots.push(join(home, ".local", "bin"));
  }
  const failures: string[] = [];
  for (const root of roots) {
    const candidate = join(root, "gh");
    try {
      return validateTrustedPath(candidate, root, uid, filesystem);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const detail = failures.length === 0 ? "no candidate exists" : failures.join("; ");
  throw new Error("Could not find a trusted GitHub CLI executable: " + detail);
}
const productionExecutables = (): ClassifierExecutablePaths => ({
  ...SYSTEM_EXECUTABLES,
  gh: resolveProductionGhExecutableForTest(process.env),
});
const PRESERVED_ENVIRONMENT = [
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "TERM",
  "XDG_CONFIG_HOME",
] as const;
const UNSAFE_SUBPROCESS_ENVIRONMENT = new Set([
  "BASH_ENV",
  "ENV",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NPM_CONFIG_NODE_OPTIONS",
  "PATH",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT",
]);
const sanitizeSubprocessEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => value !== undefined && !UNSAFE_SUBPROCESS_ENVIRONMENT.has(name),
    ),
  );
const productionSubprocessEnvironment = (): NodeJS.ProcessEnv =>
  sanitizeSubprocessEnvironment(
    Object.fromEntries(
      PRESERVED_ENVIRONMENT.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ),
  );
const validateExecutablePaths = (paths: ClassifierExecutablePaths): ClassifierExecutablePaths => {
  for (const [name, path] of Object.entries(paths)) {
    if (!path.startsWith("/")) throw new Error(`${name} executable path must be absolute`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
      throw new Error(`${name} executable path is not a trusted regular file`);
    accessSync(path, fsConstants.X_OK);
  }
  return paths;
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
  /(^|[\r\n])((?:(?:[<>]\s*|request:\s*))?(?:authorization|(?:x-)?api-key|cookie|set-cookie)\s*:\s*)(?!\[REDACTED\])[^\r\n]*/giu;
const redact = (value: string): string =>
  value
    .replace(JSON_SECRET_FIELD, '$1"[REDACTED]"')
    .replace(SECRET_HEADER, "$1$2[REDACTED]")
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
const groupHasOtherMembers = () => {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === leader) continue;
    try {
      const stat = readFileSync("/proc/" + name + "/stat", "utf8");
      const commEnd = stat.lastIndexOf(")");
      if (commEnd < 0 || stat[commEnd + 1] !== " ") continue;
      // Fields after comm begin with state (3), PPID (4), and process group ID (5).
      const fieldsAfterComm = stat.slice(commEnd + 2).trim().split(/\s+/);
      if (Number(fieldsAfterComm[2]) === leader) return true;
    } catch {}
  }
  return false;
};
const drain = () => {
  if (!childExited || groupHasOtherMembers()) return;
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
  environment: NodeJS.ProcessEnv = productionSubprocessEnvironment(),
): Promise<ProcessResult> => {
  temporaryDirectories.installHandlers();
  if (temporaryDirectories.shutdownStarted)
    throw new Error("Cannot execute a new process after shutdown has started");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", PROCESS_GROUP_WRAPPER, command, ...args], {
      cwd: workdir,
      detached: true,
      env: environment,
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
        timedOut,
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
        timedOut,
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
    const cleanupFailures: { dir: string; error: unknown }[] = [];
    for (const dir of this.#tracked) {
      try {
        rmSync(dir, { recursive: true, force: true });
        this.#tracked.delete(dir);
      } catch (error) {
        cleanupFailures.push({ dir, error });
      }
    }
    for (const { dir, error } of cleanupFailures) {
      const generatedName = basename(dir);
      const detail = redact(error instanceof Error ? error.message : String(error));
      const diagnostic = projectText({
        lines: [
          `Cancellation cleanup failure for ${generatedName}: ${detail}. Remove it directly with: rm -rf -- ${join(TEMPORARY_ROOT, generatedName)}`,
        ],
        clipMode: "tail",
        lineClipMode: "tail",
        maxLines: 1,
        maxCharacters: 2000,
        maxLineCharacters: 2000,
      });
      process.stderr.write(diagnostic.text + "\n");
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

async function classifyCiFailureWithRuntime(
  input: Input,
  runtime: ClassifierRuntime,
): Promise<Record<string, unknown>> {
  const executables = validateExecutablePaths(runtime.executables);
  const subprocessEnvironment = sanitizeSubprocessEnvironment(runtime.environment);
  if (!process.execPath.startsWith("/")) throw new Error("Node executable path must be absolute");
  const repo = input.repo ?? "NVIDIA/NemoClaw";
  const jobId = String(input.jobId);
  if (repo !== "NVIDIA/NemoClaw") throw new Error("repo must be NVIDIA/NemoClaw");
  if (!/^\d+$/.test(jobId) || jobId === "0")
    throw new Error("jobId must be a positive numeric GitHub Actions job ID");
  const maxLines = input.maxLines ?? 120;
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 500)
    throw new Error("maxLines must be an integer from 1 through 500");
  const clipMode = input.clipMode ?? "tail";
  if (!new Set(["head", "tail"]).has(clipMode)) throw new Error("clipMode must be head or tail");
  const artifactName = normalizeArtifactName(input.artifactName);
  const q = (value: unknown): string => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
  const project = (
    value: unknown,
    maxCharacters: number,
    maxLineCharacters: number = maxCharacters,
  ) =>
    projectText({
      lines: [String(value)],
      clipMode: "tail",
      lineClipMode: "tail",
      maxLines: 40,
      maxCharacters,
      maxLineCharacters,
    });
  const diagnosticError = (message: unknown): Error => {
    const safe = redact(String(message));
    return new Error(safe.slice(0, 2000) || "Diagnostic unavailable");
  };
  const isGithubAccessFailure = (detail: string): boolean =>
    [
      "authentication",
      "authorization",
      "forbidden",
      "not authorized",
      "http 401",
      "http 403",
      "resource not accessible",
      "sso",
    ].some((value) => detail.toLowerCase().includes(value));
  const githubAccessFailure = (detail: string): Error =>
    new Error(
      "GitHub access failed. Run gh auth status, then ask the user to correct authentication, authorization, SSO, or token scope before retrying." +
        (detail ? "\n" + detail : ""),
    );
  type GithubOperation =
    | "GitHub job metadata read"
    | "GitHub job log read"
    | "GitHub artifact read";
  const operationTimeout = (
    operation: GithubOperation,
  ): { executionMs: number; fixedMs: number } => {
    const fixedMs = operation === "GitHub job metadata read" ? 30000 : 60000;
    const override =
      operation === "GitHub job metadata read"
        ? runtime.timeouts?.metadataMs
        : operation === "GitHub job log read"
          ? runtime.timeouts?.logMs
          : runtime.timeouts?.artifactMs;
    return { executionMs: override ?? fixedMs, fixedMs };
  };
  const timeoutError = (operation: GithubOperation, fixedMs: number): Error =>
    new Error(
      `${operation} timed out after ${fixedMs / 1000} seconds. Check GitHub availability, then retry CI failure classification.`,
    );
  const github = async (
    args: string[],
    operation: GithubOperation = "GitHub job metadata read",
  ) => {
    const timeout = operationTimeout(operation);
    const result = await execute(
      executables.gh,
      args[0] === "api" ? ["api", "--hostname", "github.com", ...args.slice(1)] : args,
      input.workdir,
      timeout.executionMs,
      subprocessEnvironment,
    );
    if (result.timedOut) throw timeoutError(operation, timeout.fixedMs);
    if (result.exitCode !== 0) {
      const detail = result.stderr.text + "\n" + result.stdout.text;
      if (isGithubAccessFailure(detail))
        throw githubAccessFailure(
          project(result.stderr.text || result.stdout.text, 1500, 1000).text,
        );
      throw diagnosticError(result.stderr.text || result.stdout.text);
    }
    return { stdout: result.stdout.text, stderr: result.stderr.text };
  };
  const run = async (
    command: string,
    operation: "GitHub job log read" | "GitHub artifact read" | null = null,
  ) => {
    const timeout = operation
      ? operationTimeout(operation)
      : { executionMs: 30000, fixedMs: 30000 };
    const result = await execute(
      executables.bash,
      ["--noprofile", "--norc", "-c", command],
      input.workdir,
      timeout.executionMs,
      subprocessEnvironment,
    );
    if (result.timedOut && operation) throw timeoutError(operation, timeout.fixedMs);
    const detail = result.stderr.text + "\n" + result.stdout.text;
    if (result.exitCode !== 0 && isGithubAccessFailure(detail)) {
      const projected = project(result.stderr.text, 1500, 1000);
      throw githubAccessFailure(projected.text);
    }
    return result;
  };
  const cleanupTemporaryDirectory = (dir: string, kind: "CI log" | "artifact"): string => {
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
  const jobResult = await github(
    ["api", `repos/${repo}/actions/jobs/${jobId}`],
    "GitHub job metadata read",
  );
  const rawJob = JSON.parse(jobResult.stdout);
  const jobName = project(rawJob.name ?? "", 500, 500);
  const jobUrl = project(rawJob.html_url ?? "", 2000, 2000);
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
      `set +e; set -o pipefail; ${q(executables.gh)} api --hostname github.com ${q(`repos/${repo}/actions/jobs/${jobId}/logs`)} | ${q(executables.tail)} -c 4000000 > ${q(rawPath)}; statuses=("\${PIPESTATUS[@]}"); bytes=$(${q(executables.stat)} -c %s -- ${q(rawPath)}) || exit 1; printf '%s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$bytes"`,
      "GitHub job log read",
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
    logStderr = project(downloaded.stderr.text, 4000, 1000).text;
    if (logCode === 0) {
      const bounded = await run(
        `${q(executables.tail)} -n 20000 -- ${q(rawPath)} > ${q(boundedPath)}; lines=$(${q(executables.wc)} -l < ${q(rawPath)}); printf '%s' "$lines"`,
      );
      if (bounded.exitCode !== 0)
        throw diagnosticError(bounded.stderr.text || "Could not bound GitHub Actions job log");
      const lineCount = Number(bounded.stdout.text.trim());
      sourceTruncated =
        (Number.isFinite(byteCount) && byteCount >= 4000000) ||
        (Number.isFinite(lineCount) && lineCount > 20000);
      logLines = readFileSync(boundedPath, "utf8").split(/\r?\n/u);
      if (logLines.at(-1) === "") logLines.pop();
    }
  } catch (error) {
    logFailure = error;
  }
  const logCleanupFailure = cleanupTemporaryDirectory(logDir, "CI log");
  if (logFailure !== undefined) throw appendCleanupFailure(logFailure, logCleanupFailure);
  const logAcquisitionFailure =
    logCode === 0
      ? undefined
      : logStderr || `GitHub Actions log acquisition failed (exit ${logCode})`;
  if (logAcquisitionFailure) {
    const primary = isGithubAccessFailure(logAcquisitionFailure)
      ? githubAccessFailure(logAcquisitionFailure)
      : logAcquisitionFailure;
    throw appendCleanupFailure(primary, logCleanupFailure);
  }
  if (logCleanupFailure) throw new Error(logCleanupFailure);
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
  const projected = projectText({
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
  let artifactWinner: ArtifactResult | null = null;
  if (artifactName) {
    try {
      const artifacts: Record<string, unknown>[] = [];
      let artifactTotal = null;
      for (let page = 1; page <= 20; page += 1) {
        const inventoryResult = await github(
          [
            "api",
            "--include",
            `repos/${repo}/actions/runs/${job.runId}/artifacts?per_page=100&page=${page}`,
          ],
          "GitHub artifact read",
        );
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
          `output=${q(archive)}; metadata=${q(archive + ".stream")}; umask 077; set +e; set -o pipefail; ${q(executables.gh)} api --hostname github.com ${q(`repos/${repo}/actions/artifacts/${artifactId}/zip`)} | { : > "$output" || exit 1; ${q(executables.dd)} bs=65536 count=381 iflag=fullblock status=none >> "$output"; full_status=$?; ${q(executables.dd)} bs=1 count=30784 iflag=fullblock status=none >> "$output"; remainder_status=$?; extra=$(${q(executables.dd)} bs=1 count=1 iflag=fullblock status=none | ${q(executables.wc)} -c); extra_status=$?; bytes=$(${q(executables.stat)} -c %s -- "$output") || exit 1; state=ok; if [ "$extra_status" -ne 0 ]; then state=reader; elif [ "$extra" -ne 0 ]; then state=limit; elif [ "$full_status" -ne 0 ] || [ "$remainder_status" -ne 0 ]; then state=reader; fi; printf '%s %s\n' "$state" "$bytes" > "$metadata"; }; statuses=("\${PIPESTATUS[@]}"); read -r state bytes < "$metadata" || state=reader; printf '%s %s %s %s\n' "\${statuses[0]}" "\${statuses[1]}" "$state" "$bytes"`,
          "GitHub artifact read",
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
        const fileResults: ArtifactResult[] = [];
        let fileResultCount = 0;
        const malformedResultPaths: string[] = [];
        let malformedResultCount = 0;
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
            value = null;
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            malformedResultCount += 1;
            if (malformedResultPaths.length < 20)
              malformedResultPaths.push(redact(relativePath).slice(0, 1000));
            continue;
          }
          const result = value as Record<string, unknown>;
          const exitCode =
            typeof result.exitCode === "number" && Number.isInteger(result.exitCode)
              ? result.exitCode
              : null;
          const signal =
            typeof result.signal === "string" && Object.hasOwn(osConstants.signals, result.signal)
              ? result.signal
              : null;
          const timedOut = result.timedOut === true;
          const error = result.error
            ? project(String(result.error), 1000, 1000).text || null
            : null;
          if (exitCode === 0 && !signal && !error && !timedOut) continue;
          if (exitCode === null && !signal && !error && !timedOut) continue;
          const projectedResult: ArtifactResult = {
            path: redact(relativePath).slice(0, 1000),
            exitCode,
            signal,
            timedOut,
            error,
          };
          artifactWinner = selectArtifactWinner(artifactWinner, projectedResult);
          fileResultCount += 1;
          if (fileResults.length < 20) fileResults.push(projectedResult);
        }
        artifact = {
          name: artifactName,
          artifactId,
          sizeBytes,
          inventoryTruncated: false,
          filesRead,
          malformedResultCount,
          malformedResultPaths,
          malformedResultPathsTruncated: malformedResultCount > malformedResultPaths.length,
          failures: fileResults,
          failuresTruncated: fileResultCount > fileResults.length,
        };
      } catch (error) {
        artifactFailure = error;
      }
      const artifactCleanupFailure = cleanupTemporaryDirectory(dir, "artifact");
      if (artifactFailure !== undefined)
        throw appendCleanupFailure(artifactFailure, artifactCleanupFailure);
      if (artifactCleanupFailure) throw new Error(artifactCleanupFailure);
    } catch (error) {
      throw diagnosticError(error instanceof Error ? error.message : String(error));
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
  addArtifactFinding(artifactWinner, add);
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

/** @internal Test seam for explicit trusted executable fixtures. */
export async function classifyCiFailureWithRuntimeForTest(
  input: Input,
  runtime: ClassifierRuntime,
): Promise<Record<string, unknown>> {
  return await classifyCiFailureWithRuntime(input, runtime);
}

export async function classifyCiFailure(input: Input): Promise<Record<string, unknown>> {
  if (process.platform !== "linux")
    throw new Error("CI failure classification requires trusted Linux system executables");
  return await classifyCiFailureWithRuntime(input, {
    executables: productionExecutables(),
    environment: productionSubprocessEnvironment(),
  });
}

function parseArguments(args: string[]): Input {
  const values: Record<string, string> = {};
  const allowed = new Set(["workdir", "job-id", "artifact-name", "max-lines", "clip-mode"]);
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
    const diagnostic = projectText({
      lines: [error instanceof Error ? error.message : String(error)],
      clipMode: "tail",
      lineClipMode: "tail",
      maxLines: 40,
      maxCharacters: 2000,
      maxLineCharacters: 1000,
    });
    console.error(diagnostic.text || "Diagnostic unavailable");
    process.exitCode = 1;
  });
