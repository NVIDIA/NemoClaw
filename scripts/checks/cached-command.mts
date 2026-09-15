// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Reuses successful local compiler checks only while their input bytes are unchanged. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  executeValidationCommand,
  windowsNpmCli,
  withValidationNodeHeap,
} from "./validation-command.mts";

const DIGEST_INDEX_VERSION = 1;
const MAX_DIGEST_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_DIGEST_INDEX_ENTRIES = 75_000;
const DIGEST_INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type FileIdentity = {
  type: "file";
  dev: string;
  ino: string;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type DigestEntry = {
  identity: FileIdentity;
  digest: string;
  lastSeen: number;
};

type DigestIndex = Map<string, DigestEntry>;

type FingerprintTimings = {
  discovery: number;
  source: number;
  dependencies: number;
  outputs: number;
};

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return {
    type: "file",
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: Number(stat.mode),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeNs) / 1_000_000,
    ctimeMs: Number(stat.ctimeNs) / 1_000_000,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.type === right.type &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function validIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileIdentity>;
  return (
    candidate.type === "file" &&
    typeof candidate.dev === "string" &&
    /^(?:0|[1-9]\d*)$/.test(candidate.dev) &&
    typeof candidate.ino === "string" &&
    /^(?:0|[1-9]\d*)$/.test(candidate.ino) &&
    [candidate.mode, candidate.size, candidate.mtimeMs, candidate.ctimeMs].every(
      (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
    )
  );
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error("Could not identify validation inputs", { cause: result.error });
  return result.stdout;
}

function readStableFile(file: string, expected: fs.BigIntStats): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(fileIdentity(opened), fileIdentity(expected)))
      throw new Error("Validation input changed before reading");
    const bytes = fs.readFileSync(descriptor);
    if (
      !sameIdentity(
        fileIdentity(fs.fstatSync(descriptor, { bigint: true })),
        fileIdentity(opened),
      ) ||
      !sameIdentity(fileIdentity(fs.lstatSync(file, { bigint: true })), fileIdentity(opened))
    )
      throw new Error("Validation input changed while reading");
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function loadDigestIndex(file: string): DigestIndex {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_DIGEST_INDEX_BYTES)) return new Map();
    const parsed: unknown = JSON.parse(readStableFile(file, stat).toString("utf8"));
    if (!parsed || typeof parsed !== "object") return new Map();
    const candidate = parsed as { version?: unknown; entries?: unknown };
    if (
      candidate.version !== DIGEST_INDEX_VERSION ||
      !Array.isArray(candidate.entries) ||
      candidate.entries.length > MAX_DIGEST_INDEX_ENTRIES
    )
      return new Map();
    const result: DigestIndex = new Map();
    for (const item of candidate.entries) {
      if (!Array.isArray(item) || item.length !== 2) return new Map();
      const [filePath, entry] = item as [unknown, unknown];
      if (
        typeof filePath !== "string" ||
        !path.isAbsolute(filePath) ||
        !entry ||
        typeof entry !== "object"
      )
        return new Map();
      const value = entry as Partial<DigestEntry>;
      if (
        !validIdentity(value.identity) ||
        typeof value.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.digest) ||
        typeof value.lastSeen !== "number" ||
        !Number.isFinite(value.lastSeen) ||
        value.lastSeen < 0 ||
        result.has(filePath)
      )
        return new Map();
      result.set(filePath, value as DigestEntry);
    }
    return result;
  } catch {
    return new Map();
  }
}

function saveDigestIndex(file: string, entries: DigestIndex, now: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const merged = new Map(entries);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const [filePath, entry] of loadDigestIndex(file)) {
      const current = merged.get(filePath);
      if (!current || entry.lastSeen > current.lastSeen) merged.set(filePath, entry);
    }
    const retained = [...merged.entries()]
      .filter(([, entry]) => now - entry.lastSeen <= DIGEST_INDEX_MAX_AGE_MS)
      .sort((left, right) => right[1].lastSeen - left[1].lastSeen)
      .slice(0, MAX_DIGEST_INDEX_ENTRIES);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: DIGEST_INDEX_VERSION, entries: retained }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const published = loadDigestIndex(file);
    if (
      retained.every(([filePath, entry]) => {
        const observed = published.get(filePath);
        return (
          observed?.digest === entry.digest &&
          observed.lastSeen === entry.lastSeen &&
          sameIdentity(observed.identity, entry.identity)
        );
      })
    )
      return;
  }
  throw new Error("Concurrent digest-index publication did not stabilize");
}

function digestFile(file: string, expected: fs.BigIntStats, index?: DigestIndex): string {
  const canonical = fs.realpathSync(file);
  const identity = fileIdentity(expected);
  const cached = index?.get(canonical);
  if (cached && sameIdentity(cached.identity, identity)) {
    const after = fs.lstatSync(file, { bigint: true });
    if (!after.isFile() || !sameIdentity(fileIdentity(after), identity))
      throw new Error("Validation input changed while hashing");
    cached.lastSeen = Date.now();
    return cached.digest;
  }
  const digest = createHash("sha256").update(readStableFile(file, expected)).digest("hex");
  index?.set(canonical, { identity, digest, lastSeen: Date.now() });
  return digest;
}

function hashPaths(
  root: string,
  files: readonly string[],
  excludeCaches = false,
  index?: DigestIndex,
): string {
  const hash = createHash("sha256");
  const canonicalRoot = fs.realpathSync(root);
  const activeLinks = new Set<string>();
  function visit(file: string): void {
    if (excludeCaches && (path.basename(file) === ".cache" || file.endsWith(".tsbuildinfo")))
      return;
    hash.update(file).update("\0");
    const absolute = path.resolve(root, file);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing\0");
      return;
    }
    hash.update(String(stat.mode)).update("\0");
    if (stat.isSymbolicLink()) {
      hash.update(fs.readlinkSync(absolute));
      // Hash the destination too; a stable executable symlink is not tool identity.
      const resolved = fs.realpathSync(absolute);
      const target = fs.lstatSync(resolved, { bigint: true });
      if (target.isFile())
        hash
          .update(String(target.mode))
          .update("sha256\0")
          .update(digestFile(resolved, target, index));
      else {
        const relative = path.relative(canonicalRoot, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative) || activeLinks.has(resolved))
          throw new Error("External or cyclic directory symlinks prevent validation reuse");
        activeLinks.add(resolved);
        visit(resolved);
        activeLinks.delete(resolved);
      }
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(file, entry));
    } else if (stat.isFile()) hash.update("sha256\0").update(digestFile(absolute, stat, index));
    else throw new Error("Unsupported validation input");
    hash.update("\0");
  }
  for (const file of [...new Set(files)].sort()) visit(file);
  return hash.digest("hex");
}

export function validationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // npm and prek inject invocation metadata. Remove it from execution as well as
  // hashing so explicit validation and the installed hook have the same inputs.
  const result = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        (!/^npm_/i.test(key) || /^npm_config_/i.test(key)) &&
        !/^PRE_COMMIT_/.test(key) &&
        !["_", "SHLVL", "INIT_CWD", "GIT_PREFIX"].includes(key),
    ),
  );
  // The installed Git hook prepends Git's own helper directory. Preserve custom
  // overrides, but remove the default injection from both execution and identity.
  if (env.GIT_EXEC_PATH) {
    const defaultPath = spawnSync("git", ["--exec-path"], {
      env: { ...env, GIT_EXEC_PATH: undefined },
      encoding: "utf8",
    });
    if (defaultPath.status === 0 && defaultPath.stdout.trim() === env.GIT_EXEC_PATH) {
      delete result.GIT_EXEC_PATH;
      result.PATH = result.PATH?.split(path.delimiter)
        .filter((entry) => entry !== env.GIT_EXEC_PATH)
        .join(path.delimiter);
    }
  }
  if (result.PATH)
    result.PATH = [...new Set(result.PATH.split(path.delimiter))].join(path.delimiter);
  // Compiler checks use installed tools; npx must never install a missing tool.
  result.npm_config_yes = "false";
  return Object.fromEntries(
    Object.entries(withValidationNodeHeap(result)).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function validationFingerprint(
  root: string,
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  outputPaths: readonly string[] = ["dist", "nemoclaw/dist", "nemoclaw/runner-dist"],
  digestIndex?: DigestIndex,
  timings?: FingerprintTimings,
): { inputs: string; outputs: string } {
  const canonicalRoot = fs.realpathSync(root);
  const discoveryStarted = performance.now();
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
  if (timings) timings.discovery += performance.now() - discoveryStarted;
  const sourceStarted = performance.now();
  const npmCli = windowsNpmCli(root, command[0], env);
  const executable = npmCli ?? command[0];
  const resolved = path.isAbsolute(executable)
    ? executable
    : (env.PATH ?? "")
        .split(path.delimiter)
        .map((directory) => path.resolve(root, directory, executable))
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) throw new Error("Could not resolve the validation executable");
  const npm = (env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) =>
      path.resolve(root, directory, process.platform === "win32" ? "npm.cmd" : "npm"),
    )
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  const npmInputs = npm
    ? [
        process.platform === "win32"
          ? path.join(path.dirname(npm), "node_modules/npm")
          : path.resolve(fs.realpathSync(npm), "../.."),
        env.npm_config_userconfig ?? path.join(env.HOME ?? env.USERPROFILE ?? root, ".npmrc"),
        env.npm_config_globalconfig ??
          path.join(env.npm_config_prefix ?? path.resolve(process.execPath, "../.."), "etc/npmrc"),
      ]
    : [];
  for (const config of [".npmrc", "nemoclaw/.npmrc", ...npmInputs.slice(1)]) {
    const absolute = path.resolve(root, config);
    if (
      fs.existsSync(absolute) &&
      /^\s*(?:script-shell|node-options)\s*=/m.test(fs.readFileSync(absolute, "utf8"))
    )
      throw new Error("External npm execution configuration prevents validation reuse");
  }
  // These recursive inputs include ignored source files and already cover their
  // tracked children. Keep only other tracked paths in the individual file list.
  const sourceTrees = [
    "src",
    "test",
    "bin",
    "scripts",
    "agents",
    "tools",
    ".agents",
    "nemoclaw/src",
    "nemoclaw-blueprint",
  ];
  const otherFiles = files.filter(
    (file) => !sourceTrees.some((tree) => file === tree || file.startsWith(`${tree}/`)),
  );
  const inputs = createHash("sha256")
    .update(
      JSON.stringify({
        root: canonicalRoot,
        command,
        env,
        fingerprintVersion: 2,
        outputPaths,
        platform: process.platform,
        arch: process.arch,
      }),
    )
    .update(
      hashPaths(
        root,
        [
          ...otherFiles,
          ...sourceTrees,
          process.execPath,
          resolved,
          ...(npmCli ? [path.resolve(npmCli, "../..")] : []),
          ".npmrc",
          "nemoclaw/.npmrc",
          ...npmInputs,
        ],
        false,
        digestIndex,
      ),
    );
  if (timings) timings.source += performance.now() - sourceStarted;
  const dependencyStarted = performance.now();
  inputs.update(hashPaths(root, ["node_modules", "nemoclaw/node_modules"], true, digestIndex));
  if (timings) timings.dependencies += performance.now() - dependencyStarted;
  const outputsStarted = performance.now();
  const outputs = hashPaths(root, outputPaths, false, digestIndex);
  if (timings) timings.outputs += performance.now() - outputsStarted;
  return { inputs: inputs.digest("hex"), outputs };
}

type CachedCommandOptions = {
  root: string;
  label: string;
  command: string[];
  env?: NodeJS.ProcessEnv;
  outputPaths?: readonly string[];
  execute?: (env: NodeJS.ProcessEnv) => number;
  report?: (message: string) => void;
};

export function runCachedCommand(options: CachedCommandOptions): number {
  const { root, label, command } = options;
  if (!/^[a-z][a-z0-9-]*$/.test(label) || command.length === 0)
    throw new Error("Expected a check name and command");
  const env = validationEnvironment(options.env ?? process.env);
  const report = options.report ?? console.log;
  const started = performance.now();
  const cacheDirectory = path.resolve(
    root,
    git(root, ["rev-parse", "--git-path", "nemoclaw-validation"]).trim(),
  );
  const receipt = path.join(cacheDirectory, `${label}.json`);
  const digestIndexFile = path.join(cacheDirectory, "file-digests-v1.json");
  const clean = git(root, ["status", "--porcelain", "--untracked-files=all"]).length === 0;
  // External Node loaders can read files outside the repository and tool tree.
  const cacheable =
    clean &&
    !env.NODE_PATH &&
    !Object.entries(env).some(
      ([key, value]) => /^npm_config_(?:node_options|script_shell)$/i.test(key) && value,
    ) &&
    !/--(?:require|import|loader|experimental-loader)\b|(?:^|\s)-r/.test(env.NODE_OPTIONS ?? "");
  let before: ReturnType<typeof validationFingerprint> | undefined;
  const digests = loadDigestIndex(digestIndexFile);
  const beforeTimings: FingerprintTimings = {
    discovery: 0,
    source: 0,
    dependencies: 0,
    outputs: 0,
  };
  let compilerTime = 0;
  let postCheckTime = 0;
  const timingReport = () =>
    `${label}: timings discovery=${Math.round(beforeTimings.discovery)} ms, source/config=${Math.round(beforeTimings.source)} ms, dependencies=${Math.round(beforeTimings.dependencies)} ms, outputs=${Math.round(beforeTimings.outputs)} ms, compiler=${Math.round(compilerTime)} ms, post-check=${Math.round(postCheckTime)} ms, total=${Math.round(performance.now() - started)} ms`;
  try {
    if (cacheable)
      before = validationFingerprint(
        root,
        command,
        env,
        options.outputPaths,
        digests,
        beforeTimings,
      );
    if (before && fs.readFileSync(receipt, "utf8") === JSON.stringify(before)) {
      saveDigestIndex(digestIndexFile, digests, Date.now());
      report(
        `${label}: reused successful validation (${Math.round(performance.now() - started)} ms)`,
      );
      report(timingReport());
      return 0;
    }
  } catch {
    /* Unavailable or malformed evidence requires executing the check. */
  }
  try {
    fs.rmSync(receipt, { force: true });
  } catch {
    before = undefined;
  }
  const compilerStarted = performance.now();
  const status = options.execute
    ? options.execute(env)
    : executeValidationCommand(root, command, env);
  compilerTime = performance.now() - compilerStarted;
  if (status === 0 && before) {
    try {
      const postCheckStarted = performance.now();
      const after = validationFingerprint(root, command, env, options.outputPaths, digests);
      postCheckTime = performance.now() - postCheckStarted;
      if (
        before.inputs === after.inputs &&
        git(root, ["status", "--porcelain", "--untracked-files=all"]).length === 0
      ) {
        fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
        saveDigestIndex(digestIndexFile, digests, Date.now());
        const temporary = `${receipt}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(after), { mode: 0o600 });
        fs.renameSync(temporary, receipt);
      }
    } catch {
      /* A successful check remains valid even when it cannot be cached. */
    }
  }
  report(
    `${label}: ${status === 0 ? "passed" : "failed"} (${Math.round(performance.now() - started)} ms)`,
  );
  report(timingReport());
  return status;
}

export function compilerCommand(label: string): string[] {
  switch (label) {
    case "tsc-plugin":
      return ["npm", "--prefix", "nemoclaw", "run", "typecheck"];
    case "tsc-js":
      return ["bash", "-c", "npm run build:cli && npx tsc -p jsconfig.json"];
    case "tsc-cli":
      return ["npm", "run", "typecheck:cli", "--", "--incremental"];
    default:
      throw new Error("Unknown compiler check");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [label, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Expected only a compiler check name");
  process.exitCode = runCachedCommand({
    root: path.resolve(import.meta.dirname, "../.."),
    label,
    command: compilerCommand(label),
    // Plugin type checks consume source and dependencies, without compiled artifacts.
    outputPaths: label === "tsc-plugin" ? [] : undefined,
  });
}
