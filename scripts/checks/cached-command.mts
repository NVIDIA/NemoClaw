// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Reuses successful local compiler checks only while their input bytes are unchanged. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { executeValidationCommand, windowsNpmCli } from "./validation-command.mts";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error("Could not identify validation inputs", { cause: result.error });
  return result.stdout;
}

function readStableFile(file: string, expected: fs.Stats): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const identity = (stat: fs.Stats) =>
    [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || identity(opened) !== identity(expected))
      throw new Error("Validation input changed before reading");
    const bytes = fs.readFileSync(descriptor);
    if (
      identity(fs.fstatSync(descriptor)) !== identity(opened) ||
      identity(fs.lstatSync(file)) !== identity(opened)
    )
      throw new Error("Validation input changed while reading");
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function hashPaths(root: string, files: readonly string[], excludeCaches = false): string {
  const hash = createHash("sha256");
  const activeLinks = new Set<string>();
  function visit(file: string): void {
    if (excludeCaches && (path.basename(file) === ".cache" || file.endsWith(".tsbuildinfo")))
      return;
    hash.update(file).update("\0");
    const absolute = path.resolve(root, file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
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
      const target = fs.lstatSync(resolved);
      if (target.isFile())
        hash.update(String(target.mode)).update(readStableFile(resolved, target));
      else {
        const relative = path.relative(root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative) || activeLinks.has(resolved))
          throw new Error("External or cyclic directory symlinks prevent validation reuse");
        activeLinks.add(resolved);
        visit(resolved);
        activeLinks.delete(resolved);
      }
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(file, entry));
    } else if (stat.isFile()) hash.update(readStableFile(absolute, stat));
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
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function validationFingerprint(
  root: string,
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  outputPaths: readonly string[] = ["dist", "nemoclaw/dist", "nemoclaw/runner-dist"],
): { inputs: string; outputs: string } {
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
  const refs = git(root, ["rev-parse", "HEAD", "origin/main"]);
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
        root,
        command,
        env,
        refs,
        outputPaths,
        platform: process.platform,
        arch: process.arch,
      }),
    )
    .update(
      hashPaths(root, [
        ...otherFiles,
        ...sourceTrees,
        process.execPath,
        resolved,
        ...(npmCli ? [path.resolve(npmCli, "../..")] : []),
        ".npmrc",
        "nemoclaw/.npmrc",
        ...npmInputs,
      ]),
    )
    .update(hashPaths(root, ["node_modules", "nemoclaw/node_modules"], true))
    .digest("hex");
  const outputs = hashPaths(root, outputPaths);
  return { inputs, outputs };
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
  try {
    if (cacheable) before = validationFingerprint(root, command, env, options.outputPaths);
    if (before && fs.readFileSync(receipt, "utf8") === JSON.stringify(before)) {
      report(
        `${label}: reused successful validation (${Math.round(performance.now() - started)} ms)`,
      );
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
  const status = options.execute
    ? options.execute(env)
    : executeValidationCommand(root, command, env);
  if (status === 0 && before) {
    try {
      const after = validationFingerprint(root, command, env, options.outputPaths);
      if (
        before.inputs === after.inputs &&
        git(root, ["status", "--porcelain", "--untracked-files=all"]).length === 0
      ) {
        fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
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
