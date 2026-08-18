// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PortableCpuDelegationProofMode =
  | "prepare"
  | "reject"
  | "admit"
  | "diagnostics"
  | "cleanup";

export const PORTABLE_CPU_DELEGATION_PROOF_CONTRACT = Object.freeze({
  proofUser: "nemoclaw-e2e",
  targetId: "portable-cpu-delegation",
  delegationDropIn: "/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf",
  delegationDropInContent: "[Service]\nDelegate=cpu memory pids\n",
  missingDelegationDropInContent: "[Service]\nDelegate=memory pids\n",
  userSliceDropInName: "90-nemoclaw-cpu-controller.conf",
  userSliceDropInContent: "[Slice]\nCPUWeight=100\n",
  appSliceDropIn: "/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf",
  appSliceDropInContent: "[Slice]\nCPUWeight=100\n",
  controllerEvidenceReadBytes: 4097,
  immediateStartFailure: "219/CGROUP",
});

export type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandOptions = {
  readonly cwd?: string;
  readonly input?: string;
};

export interface HostCommandRunner {
  run(executable: string, argv: readonly string[], options?: CommandOptions): CommandResult;
}

export type HostPathStat = {
  readonly dev: number;
  readonly ino: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export interface HostFilesystem {
  appendText(target: string, content: string): void;
  exists(target: string): boolean;
  lstat(target: string): HostPathStat;
  makeDirectory(
    target: string,
    options: { readonly mode: number; readonly recursive: boolean },
  ): void;
  readText(target: string): string;
  removeDirectory(target: string): void;
  removeFile(target: string): void;
  writeExclusive(target: string, content: string): void;
}

export type PortableCpuDelegationProofDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly filesystem?: HostFilesystem;
  readonly runner?: HostCommandRunner;
  readonly randomId?: () => string;
  readonly sleep?: (milliseconds: number) => void;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
};

type ProofContext = {
  readonly artifactDir: string;
  readonly delegationDropIn: string;
  readonly delegationDropInDir: string;
  readonly delegationDropInDirMarker: string;
  readonly delegationDropInMarker: string;
  readonly env: NodeJS.ProcessEnv;
  readonly filesystem: HostFilesystem;
  readonly appSliceDropIn: string;
  readonly appSliceDropInDir: string;
  readonly appSliceDropInDirMarker: string;
  readonly appSliceDropInMarker: string;
  readonly proofUser: string;
  readonly randomId: () => string;
  readonly runner: HostCommandRunner;
  readonly runnerTemp: string;
  readonly sleep: (milliseconds: number) => void;
  readonly sourceCacheDir: string;
  readonly sourceCacheMarker: string;
  readonly sourceCacheParent: string;
  readonly sourceCacheParentMarker: string;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly userSliceDropInDirMarker: string;
  readonly userSliceDropInMarker: string;
  readonly workspace: string;
  readonly workspaceTraverseMarker: string;
};

type PreparedDropIn = {
  dirCreated: boolean;
  dirId: string;
  id: string;
  temp: string;
  tempId: string;
};

type PrepareState = {
  readonly appSlice: PreparedDropIn;
  createdUser: boolean;
  readonly delegation: PreparedDropIn;
  sourceCacheId: string;
  sourceCacheParentId: string;
  readonly userSlice: PreparedDropIn;
  uid: string;
};

const MODES: readonly PortableCpuDelegationProofMode[] = [
  "prepare",
  "reject",
  "admit",
  "diagnostics",
  "cleanup",
];

const MARKER_NAMES = Object.freeze({
  appSliceDropIn: "nemoclaw-app-slice-drop-in-created",
  appSliceDropInDir: "nemoclaw-app-slice-drop-in-dir-created",
  delegationDropIn: "nemoclaw-cpu-delegation-drop-in-created",
  delegationDropInDir: "nemoclaw-cpu-delegation-drop-in-dir-created",
  sourceCache: "nemoclaw-source-require-cache-created",
  sourceCacheParent: "nemoclaw-source-require-cache-parent-created",
  userSliceDropIn: "nemoclaw-user-slice-drop-in-created",
  userSliceDropInDir: "nemoclaw-user-slice-drop-in-dir-created",
  workspaceModes: "nemoclaw-workspace-traverse-modes",
});

class ProofError extends Error {}

function defaultRunner(): HostCommandRunner {
  return {
    run(executable, argv, options = {}) {
      const result = spawnSync(executable, [...argv], {
        cwd: options.cwd,
        encoding: "utf8",
        input: options.input,
        shell: false,
      });
      if (result.error) throw result.error;
      if (result.status === null) {
        throw new ProofError(
          `${executable} terminated by ${result.signal ?? "an unknown signal"}.`,
        );
      }
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

function defaultFilesystem(): HostFilesystem {
  return {
    appendText(target, content) {
      fs.appendFileSync(target, content, { encoding: "utf8" });
    },
    exists(target) {
      return fs.existsSync(target);
    },
    lstat(target) {
      return fs.lstatSync(target);
    },
    makeDirectory(target, options) {
      fs.mkdirSync(target, options);
    },
    readText(target) {
      return fs.readFileSync(target, "utf8");
    },
    removeDirectory(target) {
      fs.rmdirSync(target);
    },
    removeFile(target) {
      fs.unlinkSync(target);
    },
    writeExclusive(target, content) {
      fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    },
  };
}

function blockingSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requireAbsolutePath(value: string | undefined, name: string): string {
  if (!value || !path.isAbsolute(value) || value.includes("\0") || value.includes("\n")) {
    throw new ProofError(`${name} must be an absolute path without control bytes.`);
  }
  return path.normalize(value);
}

function requireExact(value: string | undefined, expected: string, name: string): string {
  if (value !== expected) throw new ProofError(`${name} must be ${expected}.`);
  return value;
}

function requireSha(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new ProofError("E2E_SOURCE_REVISION must be a 40-character lowercase commit SHA.");
  }
  return value;
}

function requireNumeric(value: string | undefined, name: string): string {
  if (!value || !/^[0-9]+$/u.test(value)) throw new ProofError(`${name} must be numeric.`);
  return value;
}

function userSliceDropIn(uid: string): string {
  return `/etc/systemd/system/user-${uid}.slice.d/${PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.userSliceDropInName}`;
}

function context(deps: PortableCpuDelegationProofDeps): ProofContext {
  const env = deps.env ?? process.env;
  const workspace = requireAbsolutePath(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE");
  const runnerTemp = requireAbsolutePath(env.RUNNER_TEMP, "RUNNER_TEMP");
  const artifactDir = requireAbsolutePath(env.E2E_ARTIFACT_DIR, "E2E_ARTIFACT_DIR");
  const expectedArtifactDir = path.join(workspace, "e2e-artifacts", "portable-cpu-delegation");
  if (artifactDir !== expectedArtifactDir) {
    throw new ProofError(`E2E_ARTIFACT_DIR must be ${expectedArtifactDir}.`);
  }
  requireExact(
    env.E2E_CPU_DELEGATION_USER,
    PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.proofUser,
    "E2E_CPU_DELEGATION_USER",
  );
  requireExact(env.E2E_TARGET_ID, PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.targetId, "E2E_TARGET_ID");
  requireSha(env.E2E_SOURCE_REVISION);
  const delegationDropIn = PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.delegationDropIn;
  const appSliceDropIn = PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.appSliceDropIn;
  return {
    artifactDir,
    delegationDropIn,
    delegationDropInDir: path.dirname(delegationDropIn),
    delegationDropInDirMarker: path.join(runnerTemp, MARKER_NAMES.delegationDropInDir),
    delegationDropInMarker: path.join(runnerTemp, MARKER_NAMES.delegationDropIn),
    env,
    filesystem: deps.filesystem ?? defaultFilesystem(),
    appSliceDropIn,
    appSliceDropInDir: path.dirname(appSliceDropIn),
    appSliceDropInDirMarker: path.join(runnerTemp, MARKER_NAMES.appSliceDropInDir),
    appSliceDropInMarker: path.join(runnerTemp, MARKER_NAMES.appSliceDropIn),
    proofUser: PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.proofUser,
    randomId: deps.randomId ?? randomUUID,
    runner: deps.runner ?? defaultRunner(),
    runnerTemp,
    sleep: deps.sleep ?? blockingSleep,
    sourceCacheDir: path.join(workspace, "node_modules", ".cache", "nemoclaw-source-require"),
    sourceCacheMarker: path.join(runnerTemp, MARKER_NAMES.sourceCache),
    sourceCacheParent: path.join(workspace, "node_modules", ".cache"),
    sourceCacheParentMarker: path.join(runnerTemp, MARKER_NAMES.sourceCacheParent),
    stderr: deps.stderr ?? process.stderr,
    userSliceDropInDirMarker: path.join(runnerTemp, MARKER_NAMES.userSliceDropInDir),
    userSliceDropInMarker: path.join(runnerTemp, MARKER_NAMES.userSliceDropIn),
    workspace,
    workspaceTraverseMarker: path.join(runnerTemp, MARKER_NAMES.workspaceModes),
  };
}

function run(
  ctx: ProofContext,
  executable: string,
  argv: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  return ctx.runner.run(executable, argv, options);
}

function checked(
  ctx: ProofContext,
  executable: string,
  argv: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  const result = run(ctx, executable, argv, options);
  if (result.status !== 0) {
    throw new ProofError(
      `${executable} ${argv.join(" ")} failed (${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  return result;
}

function sudo(
  ctx: ProofContext,
  argv: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  return run(ctx, "sudo", argv, options);
}

function checkedSudo(
  ctx: ProofContext,
  argv: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  return checked(ctx, "sudo", argv, options);
}

function sudoTest(ctx: ProofContext, argv: readonly string[]): boolean {
  const result = sudo(ctx, ["test", ...argv]);
  if (result.status === 0) return true;
  if (result.status === 1 && result.stderr.trim() === "") return false;
  throw new ProofError(
    `sudo test ${argv.join(" ")} failed (${String(result.status)}): ${result.stderr.trim()}`,
  );
}

function sudoExists(ctx: ProofContext, target: string): boolean {
  return sudoTest(ctx, ["-e", target]) || sudoTest(ctx, ["-L", target]);
}

function ensureDirectAbsent(ctx: ProofContext, target: string, label: string): void {
  try {
    ctx.filesystem.lstat(target);
    throw new ProofError(`${label} already exists: ${target}`);
  } catch (error) {
    if (error instanceof ProofError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeMarker(ctx: ProofContext, target: string, value: string): void {
  ctx.filesystem.writeExclusive(target, `${value}\n`);
}

function readMarker(ctx: ProofContext, target: string): string {
  return ctx.filesystem.readText(target).trim();
}

function appendGithubEnv(ctx: ProofContext, name: string, value: string): void {
  const githubEnv = requireAbsolutePath(ctx.env.GITHUB_ENV, "GITHUB_ENV");
  ctx.filesystem.appendText(githubEnv, `${name}=${value}\n`);
}

function identity(ctx: ProofContext, target: string): string {
  const value = checkedSudo(ctx, ["stat", "-Lc", "%d:%i", "--", target]).stdout.trim();
  if (!/^[0-9]+:[0-9]+$/u.test(value)) {
    throw new ProofError(`Invalid device:inode identity for ${target}.`);
  }
  return value;
}

function directIdentity(ctx: ProofContext, target: string): string {
  const value = ctx.filesystem.lstat(target);
  if (!Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino)) {
    throw new ProofError(`Invalid device:inode identity for ${target}.`);
  }
  return `${String(value.dev)}:${String(value.ino)}`;
}

function ownerMode(ctx: ProofContext, target: string): string {
  return checkedSudo(ctx, ["stat", "-Lc", "%U:%G %a", "--", target]).stdout.trim();
}

function userExists(ctx: ProofContext): boolean {
  const result = run(ctx, "getent", ["passwd", ctx.proofUser]);
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new ProofError(
    `getent passwd ${ctx.proofUser} failed (${String(result.status)}): ${result.stderr.trim()}`,
  );
}

function userComment(ctx: ProofContext): string {
  const passwd = checked(ctx, "getent", ["passwd", ctx.proofUser]).stdout.trim();
  return passwd.split(":")[4] ?? "";
}

function userHome(ctx: ProofContext): string {
  const passwd = checked(ctx, "getent", ["passwd", ctx.proofUser]).stdout.trim();
  const home = passwd.split(":")[5];
  return requireAbsolutePath(home, "proof user home");
}

function uidOf(ctx: ProofContext): string {
  return requireNumeric(checked(ctx, "id", ["-u", ctx.proofUser]).stdout.trim(), "proof UID");
}

function ensurePrivilegedDirectory(
  ctx: ProofContext,
  target: string,
  marker: string,
  createdEnv: string,
  idEnv: string,
  label: string,
  recordCreatedIdentity: (id: string) => void,
): { readonly created: boolean; readonly id: string } {
  if (
    sudoTest(ctx, ["-L", target]) ||
    (sudoTest(ctx, ["-e", target]) && !sudoTest(ctx, ["-d", target]))
  ) {
    throw new ProofError(`${label} has an unexpected type.`);
  }
  if (sudoTest(ctx, ["-d", target])) {
    if (ownerMode(ctx, target) !== "root:root 755") {
      throw new ProofError(`${label} has unexpected owner or mode.`);
    }
    return { created: false, id: "" };
  }

  appendGithubEnv(ctx, createdEnv, "unrecorded");
  checkedSudo(ctx, ["mkdir", "-m", "0755", "--", target]);
  let id = "";
  let markerPublished = false;
  try {
    id = identity(ctx, target);
    recordCreatedIdentity(id);
    appendGithubEnv(ctx, idEnv, id);
    writeMarker(ctx, marker, id);
    markerPublished = true;
    appendGithubEnv(ctx, createdEnv, "1");
    if (ownerMode(ctx, target) !== "root:root 755") {
      throw new ProofError(`${label} has unexpected owner or mode.`);
    }
    return { created: true, id };
  } catch (error) {
    const removed = id
      ? removeOwnedPath(ctx, target, id, "directory")
      : recoverUnrecordedPrivilegedDirectory(ctx, target, "root:root 755");
    if (removed) {
      if (markerPublished) safeUnlink(ctx, marker);
    } else {
      ctx.stderr.write(
        `${label} creation failed before a complete receipt could be published; inspect ${target} before retrying.\n`,
      );
    }
    throw error;
  }
}

function createOwnedDropIn(
  ctx: ProofContext,
  target: string,
  marker: string,
  template: string,
  content: string,
  idEnv: string,
  createdEnv: string,
  stagingEnv: string,
  stagingIdEnv: string,
  stagingCreatedEnv: string,
  recordState: (id: string, staging: string, stagingId: string) => void,
): void {
  if (sudoExists(ctx, target)) throw new ProofError(`Proof drop-in already exists: ${target}`);
  const targetDir = path.dirname(target);
  const nonce = ctx.randomId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(nonce)) {
    throw new ProofError("Random staging identifier has an unexpected format.");
  }
  const staging = path.join(targetDir, `${template.replace(/X+$/u, "")}${nonce}`);
  const temporary = path.join(staging, "drop-in.conf");
  appendGithubEnv(ctx, stagingEnv, staging);
  appendGithubEnv(ctx, stagingCreatedEnv, "unrecorded");
  let stagingId = "";
  let id = "";
  let markerPublished = false;
  let published = false;
  try {
    checkedSudo(ctx, ["mkdir", "-m", "0700", "--", staging]);
    stagingId = identity(ctx, staging);
    recordState(id, staging, stagingId);
    appendGithubEnv(ctx, stagingIdEnv, stagingId);
    appendGithubEnv(ctx, stagingCreatedEnv, "1");
    checkedSudo(ctx, ["tee", temporary], { input: content });
    checkedSudo(ctx, ["chown", "root:root", "--", temporary]);
    checkedSudo(ctx, ["chmod", "0644", "--", temporary]);
    id = identity(ctx, temporary);
    recordState(id, staging, stagingId);
    appendGithubEnv(ctx, createdEnv, "unrecorded");
    appendGithubEnv(ctx, idEnv, id);
    checkedSudo(ctx, ["mv", "--no-clobber", "--", temporary, target]);
    if (
      sudoTest(ctx, ["-L", target]) ||
      !sudoTest(ctx, ["-f", target]) ||
      identity(ctx, target) !== id
    ) {
      throw new ProofError(`Proof drop-in publication did not create the expected file: ${target}`);
    }
    published = true;
    writeMarker(ctx, marker, id);
    markerPublished = true;
    appendGithubEnv(ctx, createdEnv, "1");
    checkedSudo(ctx, ["rmdir", "--", staging]);
    return;
  } catch (error) {
    const targetRemoved = !published || (id !== "" && removeOwnedPath(ctx, target, id, "file"));
    const stagingRemoved = stagingId
      ? removeOwnedTree(ctx, staging, stagingId)
      : recoverUnrecordedPrivilegedDirectory(ctx, staging, "root:root 700");
    if (targetRemoved && stagingRemoved) {
      if (markerPublished) safeUnlink(ctx, marker);
    } else {
      ctx.stderr.write(
        `Proof drop-in publication rollback was incomplete for ${target}; ownership receipts were preserved.\n`,
      );
    }
    throw error;
  }
}

function emptyPreparedDropIn(): PreparedDropIn {
  return { dirCreated: false, dirId: "", id: "", temp: "", tempId: "" };
}

function prepareOwnedDropIn(
  ctx: ProofContext,
  state: PreparedDropIn,
  target: string,
  marker: string,
  directoryMarker: string,
  environmentPrefix: string,
  template: string,
  content: string,
): void {
  const directory = ensurePrivilegedDirectory(
    ctx,
    path.dirname(target),
    directoryMarker,
    `${environmentPrefix}_DROP_IN_DIR_CREATED`,
    `${environmentPrefix}_DROP_IN_DIR_ID`,
    `Proof drop-in directory ${path.dirname(target)}`,
    (id) => {
      state.dirCreated = true;
      state.dirId = id;
    },
  );
  state.dirCreated = directory.created;
  state.dirId = directory.id;
  createOwnedDropIn(
    ctx,
    target,
    marker,
    template,
    content,
    `${environmentPrefix}_DROP_IN_ID`,
    `${environmentPrefix}_DROP_IN_CREATED`,
    `${environmentPrefix}_DROP_IN_TEMP`,
    `${environmentPrefix}_DROP_IN_TEMP_ID`,
    `${environmentPrefix}_DROP_IN_TEMP_CREATED`,
    (id, temporary, temporaryId) => {
      state.id = id;
      state.temp = temporary;
      state.tempId = temporaryId;
    },
  );
}

function redact(ctx: ProofContext, content: string): string {
  return checked(ctx, "python3", ["test/e2e/lib/redact-text.py"], {
    cwd: ctx.workspace,
    input: content,
  }).stdout;
}

function persistDiagnostics(ctx: ProofContext, target: string, content: string): void {
  checkedSudo(ctx, ["tee", target], { input: redact(ctx, content) });
}

function startUserManagerWithLaterLogin(
  ctx: ProofContext,
  uid: string,
  user: string,
  diagnostics: string,
): void {
  const unit = `user@${uid}.service`;
  if (sudo(ctx, ["systemctl", "start", unit]).status === 0) return;
  const status = sudo(ctx, ["systemctl", "--no-pager", "--full", "status", unit]);
  const journal = sudo(ctx, ["journalctl", "--no-pager", "--unit", unit, "--lines", "200"]);
  persistDiagnostics(
    ctx,
    diagnostics,
    `${status.stdout}${status.stderr}${journal.stdout}${journal.stderr}`,
  );
  if (
    sudo(ctx, [
      "grep",
      "-Fq",
      PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.immediateStartFailure,
      diagnostics,
    ]).status !== 0
  ) {
    const captured = sudo(ctx, ["cat", "--", diagnostics]);
    ctx.stderr.write(`${captured.stdout}${captured.stderr}`);
    throw new ProofError(`Immediate start of ${unit} failed without 219/CGROUP.`);
  }
  sudo(ctx, ["loginctl", "terminate-user", user]);
  checkedSudo(ctx, ["--login", "--user", user, "/bin/true"]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (sudo(ctx, ["systemctl", "is-active", "--quiet", unit]).status === 0) return;
    ctx.sleep(1_000);
  }
  const captured = sudo(ctx, ["cat", "--", diagnostics]);
  ctx.stderr.write(`${captured.stdout}${captured.stderr}`);
  throw new ProofError(`Later login did not activate ${unit}.`);
}

function appendInitialReceipts(ctx: ProofContext, userCommentValue: string): void {
  const values: Readonly<Record<string, string>> = {
    E2E_CPU_DELEGATION_USER_CLAIMED: "1",
    E2E_CPU_DELEGATION_USER_COMMENT: userCommentValue,
    E2E_CPU_DELEGATION_USER_CREATED: "0",
    E2E_CPU_DELEGATION_DROP_IN_DIR: ctx.delegationDropInDir,
    E2E_CPU_DELEGATION_DROP_IN_DIR_CREATED: "0",
    E2E_CPU_DELEGATION_DROP_IN_DIR_ID: "",
    E2E_CPU_DELEGATION_DROP_IN_DIR_MARKER: ctx.delegationDropInDirMarker,
    E2E_CPU_DELEGATION_DROP_IN_MARKER: ctx.delegationDropInMarker,
    E2E_CPU_DELEGATION_DROP_IN_CREATED: "0",
    E2E_CPU_DELEGATION_DROP_IN_ID: "",
    E2E_CPU_DELEGATION_DROP_IN_TEMP: "",
    E2E_CPU_DELEGATION_DROP_IN_TEMP_CREATED: "0",
    E2E_CPU_DELEGATION_DROP_IN_TEMP_ID: "",
    E2E_APP_SLICE_DROP_IN: ctx.appSliceDropIn,
    E2E_APP_SLICE_DROP_IN_DIR: ctx.appSliceDropInDir,
    E2E_APP_SLICE_DROP_IN_DIR_CREATED: "0",
    E2E_APP_SLICE_DROP_IN_DIR_ID: "",
    E2E_APP_SLICE_DROP_IN_DIR_MARKER: ctx.appSliceDropInDirMarker,
    E2E_APP_SLICE_DROP_IN_MARKER: ctx.appSliceDropInMarker,
    E2E_APP_SLICE_DROP_IN_CREATED: "0",
    E2E_APP_SLICE_DROP_IN_ID: "",
    E2E_APP_SLICE_DROP_IN_TEMP: "",
    E2E_APP_SLICE_DROP_IN_TEMP_CREATED: "0",
    E2E_APP_SLICE_DROP_IN_TEMP_ID: "",
    E2E_USER_SLICE_DROP_IN: "",
    E2E_USER_SLICE_DROP_IN_DIR: "",
    E2E_USER_SLICE_DROP_IN_DIR_CREATED: "0",
    E2E_USER_SLICE_DROP_IN_DIR_ID: "",
    E2E_USER_SLICE_DROP_IN_DIR_MARKER: ctx.userSliceDropInDirMarker,
    E2E_USER_SLICE_DROP_IN_MARKER: ctx.userSliceDropInMarker,
    E2E_USER_SLICE_DROP_IN_CREATED: "0",
    E2E_USER_SLICE_DROP_IN_ID: "",
    E2E_USER_SLICE_DROP_IN_TEMP: "",
    E2E_USER_SLICE_DROP_IN_TEMP_CREATED: "0",
    E2E_USER_SLICE_DROP_IN_TEMP_ID: "",
    E2E_SOURCE_CACHE_DIR: ctx.sourceCacheDir,
    E2E_SOURCE_CACHE_CREATED: "0",
    E2E_SOURCE_CACHE_ID: "",
    E2E_SOURCE_CACHE_MARKER: ctx.sourceCacheMarker,
    E2E_SOURCE_CACHE_PARENT: ctx.sourceCacheParent,
    E2E_SOURCE_CACHE_PARENT_CREATED: "0",
    E2E_SOURCE_CACHE_PARENT_ID: "",
    E2E_SOURCE_CACHE_PARENT_MARKER: ctx.sourceCacheParentMarker,
    E2E_WORKSPACE_TRAVERSE_MARKER: ctx.workspaceTraverseMarker,
  };
  for (const [name, value] of Object.entries(values)) appendGithubEnv(ctx, name, value);
}

function prepareWorkspaceTraversal(ctx: ProofContext): void {
  const ancestors: string[] = [];
  let current = ctx.workspace;
  while (current !== path.dirname(current)) {
    ancestors.push(current);
    current = path.dirname(current);
  }
  ctx.filesystem.writeExclusive(ctx.workspaceTraverseMarker, "");
  for (const workspacePath of ancestors.reverse()) {
    if (sudo(ctx, ["--user", ctx.proofUser, "test", "-x", workspacePath]).status === 0) continue;
    const originalMode = checked(ctx, "stat", ["-c", "%a", "--", workspacePath]).stdout.trim();
    if (!/^[0-7]{3,4}$/u.test(originalMode)) {
      throw new ProofError(`Workspace mode is invalid for ${workspacePath}.`);
    }
    ctx.filesystem.appendText(ctx.workspaceTraverseMarker, `${originalMode}\t${workspacePath}\n`);
    checkedSudo(ctx, ["chmod", "o+x", "--", workspacePath]);
  }
  if (
    sudo(ctx, [
      "--user",
      ctx.proofUser,
      "test",
      "-x",
      path.join(ctx.workspace, "node_modules", ".bin", "vitest"),
    ]).status !== 0
  ) {
    throw new ProofError("Dedicated proof user cannot execute the Vitest entrypoint.");
  }
}

function prepareSourceCacheParent(ctx: ProofContext, state: PrepareState): void {
  try {
    const parentStat = ctx.filesystem.lstat(ctx.sourceCacheParent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new ProofError("Source-loader cache parent has an unexpected type.");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  appendGithubEnv(ctx, "E2E_SOURCE_CACHE_PARENT_CREATED", "unrecorded");
  ctx.filesystem.makeDirectory(ctx.sourceCacheParent, { recursive: false, mode: 0o755 });
  try {
    state.sourceCacheParentId = directIdentity(ctx, ctx.sourceCacheParent);
    appendGithubEnv(ctx, "E2E_SOURCE_CACHE_PARENT_ID", state.sourceCacheParentId);
    writeMarker(ctx, ctx.sourceCacheParentMarker, state.sourceCacheParentId);
    appendGithubEnv(ctx, "E2E_SOURCE_CACHE_PARENT_CREATED", "1");
  } catch (error) {
    const removed = state.sourceCacheParentId
      ? removeDirectOwnedDirectory(ctx, ctx.sourceCacheParent, state.sourceCacheParentId)
      : removeDirectUnrecordedDirectory(ctx, ctx.sourceCacheParent);
    if (!removed) {
      ctx.stderr.write(
        `Source-loader cache parent creation failed before a complete receipt was published; inspect ${ctx.sourceCacheParent} before retrying.\n`,
      );
    }
    throw error;
  }
}

function prepareSourceCache(ctx: ProofContext, state: PrepareState): void {
  prepareSourceCacheParent(ctx, state);
  if (sudo(ctx, ["--user", ctx.proofUser, "test", "-x", ctx.sourceCacheParent]).status !== 0) {
    throw new ProofError("Dedicated proof user cannot traverse the source-loader cache parent.");
  }
  if (sudoExists(ctx, ctx.sourceCacheDir)) {
    throw new ProofError("Source-loader cache already exists.");
  }
  appendGithubEnv(ctx, "E2E_SOURCE_CACHE_CREATED", "unrecorded");
  checkedSudo(ctx, ["mkdir", "-m", "0700", "--", ctx.sourceCacheDir]);
  let markerPublished = false;
  try {
    state.sourceCacheId = identity(ctx, ctx.sourceCacheDir);
    appendGithubEnv(ctx, "E2E_SOURCE_CACHE_ID", state.sourceCacheId);
    writeMarker(ctx, ctx.sourceCacheMarker, state.sourceCacheId);
    markerPublished = true;
    appendGithubEnv(ctx, "E2E_SOURCE_CACHE_CREATED", "1");
    checkedSudo(ctx, ["chown", `${state.uid}:${state.uid}`, "--", ctx.sourceCacheDir]);
  } catch (error) {
    const removed = state.sourceCacheId
      ? removeOwnedPath(ctx, ctx.sourceCacheDir, state.sourceCacheId, "directory")
      : recoverUnrecordedPrivilegedDirectory(ctx, ctx.sourceCacheDir, "root:root 700");
    if (removed) {
      if (markerPublished) safeUnlink(ctx, ctx.sourceCacheMarker);
    } else {
      ctx.stderr.write(
        `Source-loader cache creation failed before a complete receipt could be published; inspect ${ctx.sourceCacheDir} before retrying.\n`,
      );
    }
    throw error;
  }
}

function restoreWorkspaceModes(ctx: ProofContext): boolean {
  if (!ctx.filesystem.exists(ctx.workspaceTraverseMarker)) return true;
  let complete = true;
  const records = ctx.filesystem.readText(ctx.workspaceTraverseMarker).split("\n").filter(Boolean);
  for (const record of records) {
    const tab = record.indexOf("\t");
    const mode = record.slice(0, tab);
    const workspacePath = record.slice(tab + 1);
    if (tab < 0 || !/^[0-7]{3,4}$/u.test(mode) || !path.isAbsolute(workspacePath)) {
      complete = false;
      continue;
    }
    if (sudo(ctx, ["chmod", mode, "--", workspacePath]).status !== 0) complete = false;
  }
  if (complete) ctx.filesystem.removeFile(ctx.workspaceTraverseMarker);
  return complete;
}

function removeOwnedPath(
  ctx: ProofContext,
  target: string,
  expectedId: string,
  kind: "file" | "directory",
): boolean {
  if (!sudoExists(ctx, target)) return true;
  const expectedType = kind === "file" ? "-f" : "-d";
  if (sudoTest(ctx, ["-L", target]) || !sudoTest(ctx, [expectedType, target])) return false;
  if (identity(ctx, target) !== expectedId) return false;
  const operation = kind === "file" ? ["rm", "-f", "--", target] : ["rmdir", "--", target];
  return sudo(ctx, operation).status === 0 && !sudoExists(ctx, target);
}

function removeOwnedTree(ctx: ProofContext, target: string, expectedId: string): boolean {
  if (!sudoExists(ctx, target)) return true;
  if (sudoTest(ctx, ["-L", target]) || !sudoTest(ctx, ["-d", target])) return false;
  if (identity(ctx, target) !== expectedId) return false;
  return (
    sudo(ctx, ["rm", "-rf", "--one-file-system", "--", target]).status === 0 &&
    !sudoExists(ctx, target)
  );
}

function recoverUnrecordedPrivilegedDirectory(
  ctx: ProofContext,
  target: string,
  expectedOwnerMode: string,
): boolean {
  if (!sudoExists(ctx, target)) return true;
  if (sudoTest(ctx, ["-L", target]) || !sudoTest(ctx, ["-d", target])) return false;
  if (ownerMode(ctx, target) !== expectedOwnerMode) return false;
  const content = sudo(ctx, [
    "find",
    target,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-print",
    "-quit",
  ]);
  if (content.status !== 0 || content.stdout !== "") return false;
  const firstId = identity(ctx, target);
  if (identity(ctx, target) !== firstId) return false;
  return sudo(ctx, ["rmdir", "--", target]).status === 0 && !sudoExists(ctx, target);
}

function removeDirectOwnedDirectory(
  ctx: ProofContext,
  target: string,
  expectedId: string,
): boolean {
  try {
    const value = ctx.filesystem.lstat(target);
    if (
      value.isSymbolicLink() ||
      !value.isDirectory() ||
      directIdentity(ctx, target) !== expectedId
    )
      return false;
    ctx.filesystem.removeDirectory(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function removeDirectUnrecordedDirectory(ctx: ProofContext, target: string): boolean {
  try {
    const value = ctx.filesystem.lstat(target);
    if (value.isSymbolicLink() || !value.isDirectory()) return false;
    const firstId = directIdentity(ctx, target);
    if (directIdentity(ctx, target) !== firstId) return false;
    ctx.filesystem.removeDirectory(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function cleanupFailedPrepare(
  ctx: ProofContext,
  state: PrepareState,
  expectedComment: string,
): void {
  let complete = true;
  if (state.createdUser && userExists(ctx) && state.uid) {
    if (sudo(ctx, ["systemctl", "stop", `user@${state.uid}.service`]).status !== 0)
      complete = false;
  }
  for (const dropIn of [state.delegation, state.appSlice, state.userSlice])
    if (dropIn.temp && (!dropIn.tempId || !removeOwnedTree(ctx, dropIn.temp, dropIn.tempId)))
      complete = false;
  if (
    state.sourceCacheId &&
    !removeOwnedPath(ctx, ctx.sourceCacheDir, state.sourceCacheId, "directory")
  )
    complete = false;
  if (
    state.sourceCacheParentId &&
    !removeDirectOwnedDirectory(ctx, ctx.sourceCacheParent, state.sourceCacheParentId)
  )
    complete = false;
  const userSlicePath = state.uid ? userSliceDropIn(state.uid) : "";
  for (const [dropIn, target] of [
    [state.delegation, ctx.delegationDropIn],
    [state.appSlice, ctx.appSliceDropIn],
    [state.userSlice, userSlicePath],
  ] as const)
    if (dropIn.id && !removeOwnedPath(ctx, target, dropIn.id, "file")) complete = false;
  if (
    (state.delegation.id || state.appSlice.id || state.userSlice.id) &&
    sudo(ctx, ["systemctl", "daemon-reload"]).status !== 0
  )
    complete = false;
  for (const [dropIn, target] of [
    [state.appSlice, ctx.appSliceDropInDir],
    [state.delegation, ctx.delegationDropInDir],
    [state.userSlice, userSlicePath ? path.dirname(userSlicePath) : ""],
  ] as const)
    if (
      dropIn.dirCreated &&
      dropIn.dirId &&
      !removeOwnedPath(ctx, target, dropIn.dirId, "directory")
    )
      complete = false;
  if (state.createdUser && userExists(ctx)) {
    if (userComment(ctx) === expectedComment) {
      if (sudo(ctx, ["loginctl", "disable-linger", ctx.proofUser]).status !== 0) complete = false;
      sudo(ctx, ["loginctl", "terminate-user", ctx.proofUser]);
      if (sudo(ctx, ["userdel", "--remove", ctx.proofUser]).status !== 0) complete = false;
    } else {
      complete = false;
    }
  }
  if (!restoreWorkspaceModes(ctx)) complete = false;
  if (!complete)
    ctx.stderr.write(
      "Preparation rollback was incomplete; final cleanup will retry recorded resources.\n",
    );
}

function prepare(ctx: ProofContext): void {
  requireNumeric(ctx.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  requireNumeric(ctx.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
  const expectedComment = `nemoclaw-cpu-proof-${ctx.env.GITHUB_RUN_ID}-${ctx.env.GITHUB_RUN_ATTEMPT}`;
  const state: PrepareState = {
    appSlice: emptyPreparedDropIn(),
    createdUser: false,
    delegation: emptyPreparedDropIn(),
    sourceCacheId: "",
    sourceCacheParentId: "",
    userSlice: emptyPreparedDropIn(),
    uid: "",
  };
  let complete = false;
  try {
    appendInitialReceipts(ctx, expectedComment);
    if (userExists(ctx)) throw new ProofError("CPU delegation proof user already exists.");
    for (const [target, label] of [
      [ctx.delegationDropIn, "CPU delegation proof drop-in"],
      [ctx.appSliceDropIn, "app.slice proof drop-in"],
    ] as const) {
      if (sudoExists(ctx, target)) throw new ProofError(`${label} already exists.`);
    }
    for (const [marker, label] of [
      [ctx.delegationDropInMarker, "CPU delegation proof ownership marker"],
      [ctx.delegationDropInDirMarker, "CPU delegation directory marker"],
      [ctx.appSliceDropInMarker, "app.slice proof ownership marker"],
      [ctx.appSliceDropInDirMarker, "app.slice directory marker"],
      [ctx.userSliceDropInMarker, "per-user slice proof ownership marker"],
      [ctx.userSliceDropInDirMarker, "per-user slice directory marker"],
      [ctx.sourceCacheMarker, "source-cache ownership marker"],
      [ctx.sourceCacheParentMarker, "source-cache parent ownership marker"],
      [ctx.workspaceTraverseMarker, "workspace traversal receipt"],
    ] as const)
      ensureDirectAbsent(ctx, marker, label);
    checkedSudo(ctx, [
      "useradd",
      "--create-home",
      "--shell",
      "/bin/bash",
      "--comment",
      expectedComment,
      ctx.proofUser,
    ]);
    state.createdUser = true;
    appendGithubEnv(ctx, "E2E_CPU_DELEGATION_USER_CREATED", "1");
    state.uid = uidOf(ctx);
    appendGithubEnv(ctx, "E2E_CPU_DELEGATION_HOME", userHome(ctx));
    appendGithubEnv(ctx, "E2E_CPU_DELEGATION_UID", state.uid);
    appendGithubEnv(ctx, "E2E_CPU_DELEGATION_RUNTIME_DIR", `/run/user/${state.uid}`);
    const userSlice = userSliceDropIn(state.uid);
    const userSliceDir = path.dirname(userSlice);
    appendGithubEnv(ctx, "E2E_USER_SLICE_DROP_IN", userSlice);
    appendGithubEnv(ctx, "E2E_USER_SLICE_DROP_IN_DIR", userSliceDir);
    if (sudoExists(ctx, userSlice)) throw new ProofError("Per-user slice proof drop-in exists.");
    prepareWorkspaceTraversal(ctx);
    prepareSourceCache(ctx, state);
    checkedSudo(ctx, [
      "install",
      "-d",
      "-o",
      state.uid,
      "-g",
      state.uid,
      "-m",
      "0700",
      ctx.artifactDir,
    ]);
    prepareOwnedDropIn(
      ctx,
      state.userSlice,
      userSlice,
      ctx.userSliceDropInMarker,
      ctx.userSliceDropInDirMarker,
      "E2E_USER_SLICE",
      ".nemoclaw-cpu-controller.XXXXXX",
      PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.userSliceDropInContent,
    );
    prepareOwnedDropIn(
      ctx,
      state.appSlice,
      ctx.appSliceDropIn,
      ctx.appSliceDropInMarker,
      ctx.appSliceDropInDirMarker,
      "E2E_APP_SLICE",
      ".nemoclaw-cpu-controller.XXXXXX",
      PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.appSliceDropInContent,
    );
    prepareOwnedDropIn(
      ctx,
      state.delegation,
      ctx.delegationDropIn,
      ctx.delegationDropInMarker,
      ctx.delegationDropInDirMarker,
      "E2E_CPU_DELEGATION",
      ".nemoclaw-cpu-delegation.XXXXXX",
      PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.missingDelegationDropInContent,
    );
    checkedSudo(ctx, ["systemctl", "daemon-reload"]);
    checkedSudo(ctx, ["loginctl", "enable-linger", ctx.proofUser]);
    startUserManagerWithLaterLogin(
      ctx,
      state.uid,
      ctx.proofUser,
      path.join(ctx.artifactDir, "prepare-user-manager-diagnostics.txt"),
    );
    complete = true;
  } finally {
    if (!complete) cleanupFailedPrepare(ctx, state, expectedComment);
  }
}

function proofArguments(ctx: ProofContext, state: "missing" | "delegated"): readonly string[] {
  const uid = requireNumeric(ctx.env.E2E_CPU_DELEGATION_UID, "E2E_CPU_DELEGATION_UID");
  const home = requireAbsolutePath(ctx.env.E2E_CPU_DELEGATION_HOME, "E2E_CPU_DELEGATION_HOME");
  const runtimeDir = requireAbsolutePath(
    ctx.env.E2E_CPU_DELEGATION_RUNTIME_DIR,
    "E2E_CPU_DELEGATION_RUNTIME_DIR",
  );
  return [
    "--user",
    ctx.proofUser,
    "env",
    "-i",
    `E2E_ARTIFACT_DIR=${ctx.artifactDir}`,
    `E2E_CPU_DELEGATION_STATE=${state}`,
    `E2E_CPU_DELEGATION_UID=${uid}`,
    `E2E_SOURCE_REVISION=${requireSha(ctx.env.E2E_SOURCE_REVISION)}`,
    `E2E_TARGET_ID=${PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.targetId}`,
    `HOME=${home}`,
    `NEMOCLAW_RUN_LIVE_E2E=${requireExact(ctx.env.NEMOCLAW_RUN_LIVE_E2E, "1", "NEMOCLAW_RUN_LIVE_E2E")}`,
    `PATH=${ctx.env.PATH ?? ""}`,
    `XDG_RUNTIME_DIR=${runtimeDir}`,
    "./node_modules/.bin/vitest",
    "run",
    "--no-cache",
    "--project",
    "e2e-live",
    "test/e2e/live/portable-cpu-delegation-proof.test.ts",
  ];
}

function runProof(ctx: ProofContext, state: "missing" | "delegated"): void {
  checkedSudo(ctx, proofArguments(ctx, state), { cwd: ctx.workspace });
}

function expectedMarkerPath(ctx: ProofContext, envName: string, expected: string): void {
  if (ctx.env[envName] !== expected)
    throw new ProofError(`${envName} does not match its fixed receipt path.`);
}

function userSliceReceiptPaths(ctx: ProofContext) {
  const dropIn = userSliceDropIn(
    requireNumeric(ctx.env.E2E_CPU_DELEGATION_UID, "E2E_CPU_DELEGATION_UID"),
  );
  const dropInDir = path.dirname(dropIn);
  for (const [name, expected] of [
    ["E2E_USER_SLICE_DROP_IN", dropIn],
    ["E2E_USER_SLICE_DROP_IN_DIR", dropInDir],
    ["E2E_USER_SLICE_DROP_IN_MARKER", ctx.userSliceDropInMarker],
    ["E2E_USER_SLICE_DROP_IN_DIR_MARKER", ctx.userSliceDropInDirMarker],
  ] as const)
    expectedMarkerPath(ctx, name, expected);
  return { dropIn, dropInDir };
}

function validateOwnedDropIn(
  ctx: ProofContext,
  target: string,
  marker: string,
  label: string,
): void {
  const expectedId = readMarker(ctx, marker);
  if (!/^[0-9]+:[0-9]+$/u.test(expectedId))
    throw new ProofError(`${label} ownership marker is invalid.`);
  if (
    sudoTest(ctx, ["-L", target]) ||
    !sudoTest(ctx, ["-f", target]) ||
    identity(ctx, target) !== expectedId
  ) {
    throw new ProofError(`${label} identity changed before admission.`);
  }
}

function admit(ctx: ProofContext): void {
  const userSlice = userSliceReceiptPaths(ctx);
  expectedMarkerPath(ctx, "E2E_CPU_DELEGATION_DROP_IN_MARKER", ctx.delegationDropInMarker);
  expectedMarkerPath(ctx, "E2E_APP_SLICE_DROP_IN", ctx.appSliceDropIn);
  expectedMarkerPath(ctx, "E2E_APP_SLICE_DROP_IN_MARKER", ctx.appSliceDropInMarker);
  validateOwnedDropIn(
    ctx,
    ctx.delegationDropIn,
    ctx.delegationDropInMarker,
    "CPU delegation proof drop-in",
  );
  validateOwnedDropIn(ctx, ctx.appSliceDropIn, ctx.appSliceDropInMarker, "app.slice proof drop-in");
  validateOwnedDropIn(
    ctx,
    userSlice.dropIn,
    ctx.userSliceDropInMarker,
    "per-user slice proof drop-in",
  );
  const uid = requireNumeric(ctx.env.E2E_CPU_DELEGATION_UID, "E2E_CPU_DELEGATION_UID");
  checkedSudo(ctx, ["systemctl", "stop", `user@${uid}.service`]);
  checkedSudo(ctx, ["tee", ctx.delegationDropIn], {
    input: PORTABLE_CPU_DELEGATION_PROOF_CONTRACT.delegationDropInContent,
  });
  checkedSudo(ctx, ["systemctl", "daemon-reload"]);
  startUserManagerWithLaterLogin(
    ctx,
    uid,
    ctx.proofUser,
    path.join(ctx.artifactDir, "admission-user-manager-diagnostics.txt"),
  );
  runProof(ctx, "delegated");
}

function diagnostics(ctx: ProofContext): void {
  checkedSudo(ctx, ["install", "-d", "-m", "0700", ctx.artifactDir]);
  let content = `source_revision=${requireSha(ctx.env.E2E_SOURCE_REVISION)}\nproof_uid=${ctx.env.E2E_CPU_DELEGATION_UID ?? "unset"}\n`;
  const uid = ctx.env.E2E_CPU_DELEGATION_UID;
  if (uid && /^[0-9]+$/u.test(uid)) {
    const unit = `user@${uid}.service`;
    for (const [executable, argv] of [
      ["sudo", ["systemctl", "--no-pager", "--full", "status", unit]],
      ["sudo", ["journalctl", "--no-pager", "--unit", unit, "--lines", "200"]],
      [
        "sudo",
        [
          "find",
          `/sys/fs/cgroup/user.slice/user-${uid}.slice`,
          "-maxdepth",
          "3",
          "(",
          "-name",
          "cgroup.controllers",
          "-o",
          "-name",
          "cgroup.subtree_control",
          ")",
          "-print",
          "-exec",
          "cat",
          "{}",
          ";",
        ],
      ],
    ] as const) {
      const result = run(ctx, executable, argv);
      content += `${result.stdout}${result.stderr}`;
    }
  }
  const target = path.join(ctx.artifactDir, "user-manager-diagnostics.txt");
  persistDiagnostics(ctx, target, content);
  checkedSudo(ctx, ["chmod", "0600", target]);
}

function safeUnlink(ctx: ProofContext, target: string): boolean {
  try {
    ctx.filesystem.removeFile(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

type OwnershipReceipt = {
  readonly complete: boolean;
  readonly id: string;
  readonly markerOwned: boolean;
};

type CreationState = "0" | "1" | "unrecorded";

function creationState(ctx: ProofContext, name: string): CreationState | "invalid" {
  const value = ctx.env[name] ?? "0";
  return value === "0" || value === "1" || value === "unrecorded" ? value : "invalid";
}

function cleanupUserSliceReceiptPaths(ctx: ProofContext) {
  const noCreatedObjects = [
    "E2E_USER_SLICE_DROP_IN_CREATED",
    "E2E_USER_SLICE_DROP_IN_DIR_CREATED",
    "E2E_USER_SLICE_DROP_IN_TEMP_CREATED",
  ].every((name) => creationState(ctx, name) === "0");
  if (noCreatedObjects && !ctx.env.E2E_USER_SLICE_DROP_IN && !ctx.env.E2E_USER_SLICE_DROP_IN_DIR)
    return undefined;
  return userSliceReceiptPaths(ctx);
}

function ownershipReceipt(ctx: ProofContext, marker: string, idEnv: string): OwnershipReceipt {
  const environmentId = ctx.env[idEnv] ?? "";
  const environmentIdValid = /^[0-9]+:[0-9]+$/u.test(environmentId);
  if (!ctx.filesystem.exists(marker)) {
    return environmentId === "" || environmentIdValid
      ? { complete: true, id: environmentId, markerOwned: false }
      : { complete: false, id: "", markerOwned: false };
  }
  const markerId = readMarker(ctx, marker);
  const markerIdValid = /^[0-9]+:[0-9]+$/u.test(markerId);
  if (markerIdValid && (environmentId === "" || markerId === environmentId)) {
    return { complete: true, id: markerId, markerOwned: true };
  }
  return environmentIdValid
    ? { complete: false, id: environmentId, markerOwned: false }
    : { complete: false, id: "", markerOwned: false };
}

function removeFromReceipt(
  ctx: ProofContext,
  target: string,
  marker: string,
  idEnv: string,
  createdEnv: string,
  kind: "file" | "directory",
  unrecordedOwnerMode = "",
): boolean {
  const state = creationState(ctx, createdEnv);
  const receipt = ownershipReceipt(ctx, marker, idEnv);
  if (state === "invalid") return false;
  if (state === "0") return receipt.id === "" && receipt.complete;
  if (receipt.id === "") {
    return state === "unrecorded"
      ? kind === "file"
        ? !sudoExists(ctx, target)
        : recoverUnrecordedPrivilegedDirectory(ctx, target, unrecordedOwnerMode)
      : false;
  }
  if (!removeOwnedPath(ctx, target, receipt.id, kind)) return false;
  if (receipt.markerOwned && !safeUnlink(ctx, marker)) return false;
  return receipt.complete;
}

function cleanupSourceCache(ctx: ProofContext): boolean {
  const state = creationState(ctx, "E2E_SOURCE_CACHE_CREATED");
  const receipt = ownershipReceipt(ctx, ctx.sourceCacheMarker, "E2E_SOURCE_CACHE_ID");
  if (state === "invalid") return false;
  if (state === "0") return receipt.id === "" && receipt.complete;
  if (receipt.id === "") {
    return state === "unrecorded"
      ? recoverUnrecordedPrivilegedDirectory(ctx, ctx.sourceCacheDir, "root:root 700")
      : false;
  }
  if (!sudoExists(ctx, ctx.sourceCacheDir)) {
    if (receipt.markerOwned && !safeUnlink(ctx, ctx.sourceCacheMarker)) return false;
    return receipt.complete;
  }
  if (sudoTest(ctx, ["-L", ctx.sourceCacheDir]) || !sudoTest(ctx, ["-d", ctx.sourceCacheDir]))
    return false;
  if (identity(ctx, ctx.sourceCacheDir) !== receipt.id) return false;
  if (
    sudo(ctx, ["rm", "-rf", "--one-file-system", "--", ctx.sourceCacheDir]).status !== 0 ||
    sudoExists(ctx, ctx.sourceCacheDir)
  )
    return false;
  if (receipt.markerOwned && !safeUnlink(ctx, ctx.sourceCacheMarker)) return false;
  return receipt.complete;
}

function cleanupSourceCacheParent(ctx: ProofContext): boolean {
  const state = creationState(ctx, "E2E_SOURCE_CACHE_PARENT_CREATED");
  const receipt = ownershipReceipt(ctx, ctx.sourceCacheParentMarker, "E2E_SOURCE_CACHE_PARENT_ID");
  if (state === "invalid") return false;
  if (state === "0") return receipt.id === "" && receipt.complete;
  if (receipt.id === "") {
    return state === "unrecorded"
      ? removeDirectUnrecordedDirectory(ctx, ctx.sourceCacheParent)
      : false;
  }
  if (!removeDirectOwnedDirectory(ctx, ctx.sourceCacheParent, receipt.id)) return false;
  if (receipt.markerOwned && !safeUnlink(ctx, ctx.sourceCacheParentMarker)) return false;
  return receipt.complete;
}

function cleanupTemporary(
  ctx: ProofContext,
  pathEnv: string,
  idEnv: string,
  createdEnv: string,
  targetDirectory: string,
  namePrefix: string,
): boolean {
  const state = creationState(ctx, createdEnv);
  const temporary = ctx.env[pathEnv] ?? "";
  const expectedId = ctx.env[idEnv] ?? "";
  if (state === "invalid") return false;
  if (state === "0") return temporary === "" && expectedId === "";
  if (
    !path.isAbsolute(temporary) ||
    path.dirname(temporary) !== targetDirectory ||
    !path.basename(temporary).startsWith(namePrefix) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      path.basename(temporary).slice(namePrefix.length),
    )
  )
    return false;
  if (expectedId === "") {
    return state === "unrecorded"
      ? recoverUnrecordedPrivilegedDirectory(ctx, temporary, "root:root 700")
      : false;
  }
  if (!/^[0-9]+:[0-9]+$/u.test(expectedId)) return false;
  return removeOwnedTree(ctx, temporary, expectedId);
}

function cleanup(ctx: ProofContext): void {
  let complete = true;
  let userSlice: ReturnType<typeof cleanupUserSliceReceiptPaths>;
  try {
    userSlice = cleanupUserSliceReceiptPaths(ctx);
  } catch (error) {
    ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    complete = false;
  }
  const claimed = ctx.env.E2E_CPU_DELEGATION_USER_CLAIMED === "1";
  const expectedComment = ctx.env.E2E_CPU_DELEGATION_USER_COMMENT ?? "";
  let ownedUser = false;
  let uid = "";
  if (claimed && userExists(ctx)) {
    if (expectedComment && userComment(ctx) === expectedComment) {
      ownedUser = true;
      uid = uidOf(ctx);
      if (sudo(ctx, ["systemctl", "stop", `user@${uid}.service`]).status !== 0) complete = false;
    } else {
      complete = false;
    }
  }
  const temporaries: [string, string, string, string, string][] = [
    [
      "E2E_CPU_DELEGATION_DROP_IN_TEMP",
      "E2E_CPU_DELEGATION_DROP_IN_TEMP_ID",
      "E2E_CPU_DELEGATION_DROP_IN_TEMP_CREATED",
      ctx.delegationDropInDir,
      ".nemoclaw-cpu-delegation.",
    ],
    [
      "E2E_APP_SLICE_DROP_IN_TEMP",
      "E2E_APP_SLICE_DROP_IN_TEMP_ID",
      "E2E_APP_SLICE_DROP_IN_TEMP_CREATED",
      ctx.appSliceDropInDir,
      ".nemoclaw-cpu-controller.",
    ],
  ];
  if (userSlice)
    temporaries.push([
      "E2E_USER_SLICE_DROP_IN_TEMP",
      "E2E_USER_SLICE_DROP_IN_TEMP_ID",
      "E2E_USER_SLICE_DROP_IN_TEMP_CREATED",
      userSlice.dropInDir,
      ".nemoclaw-cpu-controller.",
    ]);
  for (const temporary of temporaries) if (!cleanupTemporary(ctx, ...temporary)) complete = false;
  const dropIns: [string, string, string, string][] = [
    [
      ctx.delegationDropIn,
      ctx.delegationDropInMarker,
      "E2E_CPU_DELEGATION_DROP_IN_ID",
      "E2E_CPU_DELEGATION_DROP_IN_CREATED",
    ],
    [
      ctx.appSliceDropIn,
      ctx.appSliceDropInMarker,
      "E2E_APP_SLICE_DROP_IN_ID",
      "E2E_APP_SLICE_DROP_IN_CREATED",
    ],
  ];
  if (userSlice)
    dropIns.push([
      userSlice.dropIn,
      ctx.userSliceDropInMarker,
      "E2E_USER_SLICE_DROP_IN_ID",
      "E2E_USER_SLICE_DROP_IN_CREATED",
    ]);
  for (const dropIn of dropIns) if (!removeFromReceipt(ctx, ...dropIn, "file")) complete = false;
  if (!cleanupSourceCache(ctx)) complete = false;
  if (!cleanupSourceCacheParent(ctx)) complete = false;
  if (sudo(ctx, ["systemctl", "daemon-reload"]).status !== 0) complete = false;
  const directories: [string, string, string, string][] = [
    [
      ctx.appSliceDropInDir,
      ctx.appSliceDropInDirMarker,
      "E2E_APP_SLICE_DROP_IN_DIR_ID",
      "E2E_APP_SLICE_DROP_IN_DIR_CREATED",
    ],
    [
      ctx.delegationDropInDir,
      ctx.delegationDropInDirMarker,
      "E2E_CPU_DELEGATION_DROP_IN_DIR_ID",
      "E2E_CPU_DELEGATION_DROP_IN_DIR_CREATED",
    ],
  ];
  if (userSlice)
    directories.push([
      userSlice.dropInDir,
      ctx.userSliceDropInDirMarker,
      "E2E_USER_SLICE_DROP_IN_DIR_ID",
      "E2E_USER_SLICE_DROP_IN_DIR_CREATED",
    ]);
  for (const directory of directories)
    if (!removeFromReceipt(ctx, ...directory, "directory", "root:root 755")) complete = false;
  if (ownedUser && userExists(ctx)) {
    if (sudo(ctx, ["loginctl", "disable-linger", ctx.proofUser]).status !== 0) complete = false;
    sudo(ctx, ["loginctl", "terminate-user", ctx.proofUser]);
    if (sudo(ctx, ["userdel", "--remove", ctx.proofUser]).status !== 0 || userExists(ctx))
      complete = false;
  }
  if (
    ctx.filesystem.exists(ctx.artifactDir) &&
    sudo(ctx, [
      "chown",
      "-R",
      `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
      ctx.artifactDir,
    ]).status !== 0
  )
    complete = false;
  if (!restoreWorkspaceModes(ctx)) complete = false;
  if (!complete)
    throw new ProofError("CPU delegation proof cleanup was incomplete; receipts were preserved.");
}

export function parsePortableCpuDelegationProofMode(
  argv: readonly string[],
): PortableCpuDelegationProofMode {
  if (argv.length !== 1 || !MODES.includes(argv[0] as PortableCpuDelegationProofMode)) {
    throw new ProofError(`Expected exactly one mode: ${MODES.join(" | ")}.`);
  }
  return argv[0] as PortableCpuDelegationProofMode;
}

export function runPortableCpuDelegationProofMode(
  mode: PortableCpuDelegationProofMode,
  deps: PortableCpuDelegationProofDeps = {},
): void {
  const ctx = context(deps);
  const modes: Record<PortableCpuDelegationProofMode, (value: ProofContext) => void> = {
    prepare,
    reject: (value) => runProof(value, "missing"),
    admit,
    diagnostics,
    cleanup,
  };
  modes[mode](ctx);
}

export function portableCpuDelegationProofCli(
  argv: readonly string[] = process.argv.slice(2),
  deps: PortableCpuDelegationProofDeps = {},
): void {
  runPortableCpuDelegationProofMode(parsePortableCpuDelegationProofMode(argv), deps);
}

function installSupplementalSignalHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  installSupplementalSignalHandlers();
  try {
    portableCpuDelegationProofCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
