// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export type ProtectedOutputIdentity = { dev: bigint; ino: bigint };
type FileIdentity = ProtectedOutputIdentity;
type FileMetadata = BigIntStats;

export type ProtectedOutputBoundary = {
  outputPath: string;
  outputParentPath: string;
  outputParentIdentity: ProtectedOutputIdentity;
  ownerUid: bigint;
};

type PathState =
  | { kind: "present"; metadata: FileMetadata }
  | { kind: "absent" }
  | { kind: "unknown"; error: unknown };

export type ProtectedOutputOperations = {
  mkdtemp: (prefix: string) => string;
  open: (filePath: string, flags: number, mode: number) => number;
  fstat: (descriptor: number) => FileIdentity;
  fchmod: (descriptor: number, mode: number) => void;
  write: (descriptor: number, value: string) => void;
  fsync: (descriptor: number) => void;
  close: (descriptor: number) => void;
  link: (temporaryPath: string, outputPath: string) => void;
};

export type ProtectedOutputOptions = {
  artifactName: string;
  operations?: Partial<ProtectedOutputOperations>;
  beforePublish?: (temporaryPath: string, outputPath: string) => void;
  beforeCleanup?: (temporaryPath: string, stagingDirectoryPath: string) => void;
};

type StagingWorkspace = {
  outputParentPath: string;
  outputParentIdentity: FileIdentity;
  ownerUid: bigint;
  directoryPath: string;
  directoryIdentity: FileIdentity;
  temporaryPath: string;
  temporaryIdentity?: FileIdentity;
  cleanupHookInvoked: boolean;
  beforeCleanup?: ProtectedOutputOptions["beforeCleanup"];
};

type CleanupResult = { detail: string; unresolved: boolean };

const DEFAULT_OPERATIONS: ProtectedOutputOperations = {
  mkdtemp: (prefix) => mkdtempSync(prefix),
  open: (filePath, flags, mode) => openSync(filePath, flags, mode),
  fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
  fchmod: (descriptor, mode) => fchmodSync(descriptor, mode),
  write: (descriptor, value) => writeFileSync(descriptor, value, "utf8"),
  fsync: (descriptor) => fsyncSync(descriptor),
  close: (descriptor) => closeSync(descriptor),
  link: (temporaryPath, outputPath) => linkSync(temporaryPath, outputPath),
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function escapeDiagnosticControls(message: string): string {
  return Array.from(message, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return character;
    const isControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    if (!isControl) return character;
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }).join("");
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && ("path" in error || "dest" in error)) {
    const code = errorCode(error) ?? "filesystem error";
    const syscall =
      "syscall" in error && typeof error.syscall === "string" ? error.syscall : undefined;
    return escapeDiagnosticControls(syscall ? `${code} during ${syscall}` : code);
  }
  return escapeDiagnosticControls(error instanceof Error ? error.message : String(error));
}

function quotePath(filePath: string): string {
  return escapeDiagnosticControls(JSON.stringify(filePath));
}

export function protectedOutputDiagnostic(error: unknown): string {
  return errorMessage(error);
}

export function quoteProtectedOutputPath(filePath: string): string {
  return quotePath(filePath);
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(metadata: FileMetadata): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function pathState(filePath: string): PathState {
  try {
    return { kind: "present", metadata: lstatSync(filePath, { bigint: true }) };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unknown", error };
  }
}

function stateDetail(label: string, filePath: string, state: PathState): string {
  if (state.kind === "present") return `Preserved ${label} ${quotePath(filePath)}`;
  if (state.kind === "absent") return `${label} is absent ${quotePath(filePath)}`;
  return `${label} status is unknown for ${quotePath(filePath)}: ${errorMessage(state.error)}`;
}

function directoryMetadata(directoryPath: string): FileMetadata {
  let metadata: FileMetadata;
  try {
    metadata = lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    throw new Error(
      `Could not inspect protected directory ${quotePath(directoryPath)}: ${errorMessage(error)}`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Protected directory is not a real directory: ${quotePath(directoryPath)}`);
  }
  return metadata;
}

function effectiveUid(): bigint {
  if (typeof process.geteuid !== "function") {
    throw new Error("Protected JSON output requires a POSIX effective user identity");
  }
  return BigInt(process.geteuid());
}

function hasExactOwnerOnlyDirectoryMode(metadata: Pick<FileMetadata, "mode">): boolean {
  return (metadata.mode & 0o7777n) === 0o700n;
}

export function ancestorEntryIsProtected(
  parentMetadata: Pick<FileMetadata, "mode" | "uid">,
  childMetadata: Pick<FileMetadata, "uid">,
  ownerUid: bigint,
): boolean {
  const trustedOwner = parentMetadata.uid === ownerUid || parentMetadata.uid === 0n;
  if (!trustedOwner) return false;

  const writableByAnotherIdentity = (parentMetadata.mode & 0o022n) !== 0n;
  if (!writableByAnotherIdentity) return true;

  const sticky = (parentMetadata.mode & 0o1000n) !== 0n;
  return sticky && childMetadata.uid === ownerUid;
}

function trustedOutputParent(outputPath: string): {
  directoryPath: string;
  directoryIdentity: FileIdentity;
  ownerUid: bigint;
} {
  const ownerUid = effectiveUid();
  const directoryPath = path.dirname(outputPath);
  let childPath = directoryPath;
  let childMetadata = directoryMetadata(childPath);
  if (childMetadata.uid !== ownerUid || !hasExactOwnerOnlyDirectoryMode(childMetadata)) {
    throw new Error(
      `Protected output parent must be owned by effective UID ${ownerUid} with mode 0700: ${quotePath(directoryPath)}`,
    );
  }
  const directoryIdentity = identity(childMetadata);

  for (;;) {
    const parentPath = path.dirname(childPath);
    if (parentPath === childPath) break;
    const parentMetadata = directoryMetadata(parentPath);
    if (!ancestorEntryIsProtected(parentMetadata, childMetadata, ownerUid)) {
      throw new Error(
        `Protected output ancestor permits an untrusted pathname swap: ${quotePath(parentPath)}`,
      );
    }
    childPath = parentPath;
    childMetadata = parentMetadata;
  }

  return { directoryPath, directoryIdentity, ownerUid };
}

function canonicalOutputPath(requestedOutputPath: string): string {
  const resolvedPath = path.resolve(requestedOutputPath);
  const resolvedParent = path.dirname(resolvedPath);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync.native(resolvedParent);
  } catch (error) {
    throw new Error(
      `Could not resolve protected output directory ${quotePath(resolvedParent)}: ${errorMessage(error)}`,
    );
  }
  const exactMacOsAlias =
    process.platform === "darwin" &&
    (resolvedParent === "/var" ||
      resolvedParent.startsWith("/var/") ||
      resolvedParent === "/tmp" ||
      resolvedParent.startsWith("/tmp/")) &&
    canonicalParent === `/private${resolvedParent}`;
  if (canonicalParent !== resolvedParent && !exactMacOsAlias) {
    throw new Error(
      `Protected output parent contains an untrusted symbolic-link path: ${quotePath(resolvedParent)}`,
    );
  }
  return path.join(canonicalParent, path.basename(resolvedPath));
}

export function prepareProtectedOutputBoundary(
  requestedOutputPath: string,
  artifactName: string,
): ProtectedOutputBoundary {
  const boundary = prepareProtectedOutputParentBoundary(requestedOutputPath);
  try {
    lstatSync(boundary.outputPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return boundary;
    throw new Error(
      `Could not inspect ${artifactName} output ${quotePath(boundary.outputPath)}: ${errorMessage(error)}`,
    );
  }
  throw new Error(
    `${artifactName} output already exists and will not be overwritten: ${quotePath(boundary.outputPath)}`,
  );
}

export function prepareProtectedOutputParentBoundary(
  requestedOutputPath: string,
): ProtectedOutputBoundary {
  const outputPath = canonicalOutputPath(requestedOutputPath);
  const outputParent = trustedOutputParent(outputPath);
  return {
    outputPath,
    outputParentPath: outputParent.directoryPath,
    outputParentIdentity: outputParent.directoryIdentity,
    ownerUid: outputParent.ownerUid,
  };
}

export function protectedOutputBoundaryFailure(boundary: ProtectedOutputBoundary): string | null {
  let currentParent: ReturnType<typeof trustedOutputParent>;
  try {
    currentParent = trustedOutputParent(boundary.outputPath);
  } catch (error) {
    return `Protected output parent is no longer trusted: ${errorMessage(error)}`;
  }
  if (
    currentParent.ownerUid !== boundary.ownerUid ||
    !sameFile(currentParent.directoryIdentity, boundary.outputParentIdentity)
  ) {
    return `Protected output parent identity changed: ${quotePath(boundary.outputParentPath)}`;
  }
  return null;
}

export function assertProtectedOutputAbsent(
  requestedOutputPath: string,
  artifactName: string,
): string {
  return prepareProtectedOutputBoundary(requestedOutputPath, artifactName).outputPath;
}

function createStagingWorkspace(
  outputPath: string,
  operations: ProtectedOutputOperations,
  beforeCleanup?: ProtectedOutputOptions["beforeCleanup"],
): StagingWorkspace {
  const outputParent = trustedOutputParent(outputPath);
  const prefix = path.join(
    outputParent.directoryPath,
    `.${path.basename(outputPath)}.nemoclaw-stage-`,
  );
  const directoryPath = operations.mkdtemp(prefix);
  const directoryState = pathState(directoryPath);
  if (
    directoryState.kind !== "present" ||
    !directoryState.metadata.isDirectory() ||
    directoryState.metadata.uid !== outputParent.ownerUid ||
    !hasExactOwnerOnlyDirectoryMode(directoryState.metadata)
  ) {
    throw new Error(
      `Protected staging directory could not be identified. ${stateDetail("Invocation-created staging directory", directoryPath, directoryState)}.`,
    );
  }
  return {
    outputParentPath: outputParent.directoryPath,
    outputParentIdentity: outputParent.directoryIdentity,
    ownerUid: outputParent.ownerUid,
    directoryPath,
    directoryIdentity: identity(directoryState.metadata),
    temporaryPath: path.join(directoryPath, "output.json"),
    cleanupHookInvoked: false,
    beforeCleanup,
  };
}

function workspaceBoundary(workspace: StagingWorkspace): CleanupResult {
  let outputParent: ReturnType<typeof trustedOutputParent>;
  try {
    outputParent = trustedOutputParent(path.join(workspace.outputParentPath, ".boundary"));
  } catch (error) {
    return {
      detail: `Protected output parent is no longer trusted: ${errorMessage(error)}. Preserved staging directory ${quotePath(workspace.directoryPath)}`,
      unresolved: true,
    };
  }
  if (
    outputParent.ownerUid !== workspace.ownerUid ||
    !sameFile(outputParent.directoryIdentity, workspace.outputParentIdentity)
  ) {
    return {
      detail: `Protected output parent identity changed. Preserved staging directory ${quotePath(workspace.directoryPath)}`,
      unresolved: true,
    };
  }

  const directoryState = pathState(workspace.directoryPath);
  if (
    directoryState.kind !== "present" ||
    !directoryState.metadata.isDirectory() ||
    directoryState.metadata.uid !== workspace.ownerUid ||
    !hasExactOwnerOnlyDirectoryMode(directoryState.metadata) ||
    !sameFile(directoryState.metadata, workspace.directoryIdentity)
  ) {
    return {
      detail: `${stateDetail("Possible invocation-created staging directory", workspace.directoryPath, directoryState)}. Cleanup boundary is not trusted`,
      unresolved: true,
    };
  }
  return { detail: "Cleanup boundary is trusted", unresolved: false };
}

function invokeCleanupHook(workspace: StagingWorkspace): CleanupResult | undefined {
  if (workspace.cleanupHookInvoked || !workspace.beforeCleanup) return undefined;
  workspace.cleanupHookInvoked = true;
  try {
    workspace.beforeCleanup(workspace.temporaryPath, workspace.directoryPath);
    return undefined;
  } catch (error) {
    return {
      detail: `Cleanup preparation failed: ${errorMessage(error)}. Preserved staging directory ${quotePath(workspace.directoryPath)}`,
      unresolved: true,
    };
  }
}

function removeOwnedDirectory(workspace: StagingWorkspace): CleanupResult {
  const boundary = workspaceBoundary(workspace);
  if (boundary.unresolved) return boundary;
  const directoryState = pathState(workspace.directoryPath);
  if (directoryState.kind === "absent") {
    return {
      detail: `Invocation-created staging directory is absent ${quotePath(workspace.directoryPath)}`,
      unresolved: false,
    };
  }
  if (
    directoryState.kind === "unknown" ||
    !sameFile(directoryState.metadata, workspace.directoryIdentity)
  ) {
    return {
      detail: stateDetail(
        "Possible invocation-created staging directory",
        workspace.directoryPath,
        directoryState,
      ),
      unresolved: true,
    };
  }
  try {
    rmdirSync(workspace.directoryPath);
    return {
      detail: `Removed invocation-created staging directory ${quotePath(workspace.directoryPath)}`,
      unresolved: false,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        detail: `Invocation-created staging directory is absent ${quotePath(workspace.directoryPath)}`,
        unresolved: false,
      };
    }
    return {
      detail: `Preserved invocation-created staging directory ${quotePath(workspace.directoryPath)}: ${errorMessage(error)}`,
      unresolved: true,
    };
  }
}

function removeOwnedTemporaryPath(workspace: StagingWorkspace): CleanupResult {
  const hookFailure = invokeCleanupHook(workspace);
  if (hookFailure) return hookFailure;
  const boundary = workspaceBoundary(workspace);
  if (boundary.unresolved) return boundary;
  const temporaryState = pathState(workspace.temporaryPath);
  if (temporaryState.kind === "absent") return removeOwnedDirectory(workspace);
  if (
    temporaryState.kind === "unknown" ||
    !workspace.temporaryIdentity ||
    !sameFile(temporaryState.metadata, workspace.temporaryIdentity)
  ) {
    return {
      detail: `${stateDetail("Possible invocation-created temporary path", workspace.temporaryPath, temporaryState)}. Preserved staging directory ${quotePath(workspace.directoryPath)}`,
      unresolved: true,
    };
  }
  try {
    unlinkSync(workspace.temporaryPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return {
        detail: `Preserved invocation-created temporary path ${quotePath(workspace.temporaryPath)}: ${errorMessage(error)}. Preserved staging directory ${quotePath(workspace.directoryPath)}`,
        unresolved: true,
      };
    }
  }
  const directoryCleanup = removeOwnedDirectory(workspace);
  return {
    detail: `Removed invocation-created temporary path ${quotePath(workspace.temporaryPath)}. ${directoryCleanup.detail}`,
    unresolved: directoryCleanup.unresolved,
  };
}

function preserveWorkspaceDetail(workspace: StagingWorkspace): string {
  return `${stateDetail("Possible invocation-created temporary path", workspace.temporaryPath, pathState(workspace.temporaryPath))}. ${stateDetail("Possible invocation-created staging directory", workspace.directoryPath, pathState(workspace.directoryPath))}`;
}

function stageOutput(
  contents: string,
  workspace: StagingWorkspace,
  operations: ProtectedOutputOperations,
): void {
  const flags =
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let descriptor: number;
  try {
    descriptor = operations.open(workspace.temporaryPath, flags, 0o600);
  } catch (error) {
    const cleanup = removeOwnedTemporaryPath(workspace);
    throw new Error(
      `Protected output staging allocation failed: ${errorMessage(error)}. ${cleanup.detail}.`,
    );
  }

  try {
    workspace.temporaryIdentity = operations.fstat(descriptor);
  } catch (error) {
    let closeFailure: unknown;
    try {
      operations.close(descriptor);
    } catch (closeError) {
      closeFailure = closeError;
    }
    throw new Error(
      `Protected output staging identity could not be recorded: ${errorMessage(error)}. Descriptor close ${closeFailure ? `failed: ${errorMessage(closeFailure)}` : "was confirmed"}. ${preserveWorkspaceDetail(workspace)}.`,
    );
  }

  let failure: unknown;
  let descriptorClosed = false;
  try {
    operations.fchmod(descriptor, 0o600);
    operations.write(descriptor, contents);
    operations.fsync(descriptor);
  } catch (error) {
    failure = error;
  }
  try {
    operations.close(descriptor);
    descriptorClosed = true;
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "Protected output write and descriptor close failed")
      : error;
  }
  if (!failure) return;

  const cleanup = descriptorClosed
    ? removeOwnedTemporaryPath(workspace)
    : {
        detail: `Descriptor close was not confirmed. ${preserveWorkspaceDetail(workspace)}`,
        unresolved: true,
      };
  throw new Error(
    `Protected output staging failed: ${errorMessage(failure)}. This invocation did not publish the output. ${cleanup.detail}.`,
  );
}

function ambiguousPublicationError(
  artifactName: string,
  outputPath: string,
  workspace: StagingWorkspace,
  finalizationError: unknown,
): Error {
  return new Error(
    `${artifactName} finalization returned an error for ${quotePath(outputPath)}: ${errorMessage(finalizationError)}. Target ownership is ambiguous. ${stateDetail("Possible output target", outputPath, pathState(outputPath))}. ${preserveWorkspaceDetail(workspace)}. Inspect the exact paths; do not rerun with this output path.`,
  );
}

function reconcilePublicationFailure(
  artifactName: string,
  outputPath: string,
  workspace: StagingWorkspace,
  finalizationError: unknown,
): never {
  const targetState = pathState(outputPath);
  const temporaryState = pathState(workspace.temporaryPath);
  const temporaryOwned =
    temporaryState.kind === "present" &&
    workspace.temporaryIdentity !== undefined &&
    sameFile(temporaryState.metadata, workspace.temporaryIdentity);

  if (targetState.kind === "unknown" || !temporaryOwned) {
    throw ambiguousPublicationError(artifactName, outputPath, workspace, finalizationError);
  }
  if (
    targetState.kind === "present" &&
    workspace.temporaryIdentity &&
    sameFile(targetState.metadata, workspace.temporaryIdentity)
  ) {
    throw ambiguousPublicationError(artifactName, outputPath, workspace, finalizationError);
  }

  const cleanup = removeOwnedTemporaryPath(workspace);
  if (targetState.kind === "absent") {
    throw new Error(
      `${artifactName} finalization failed for ${quotePath(outputPath)}: ${errorMessage(finalizationError)}. This invocation did not publish the output. ${cleanup.detail}.`,
    );
  }
  const message =
    errorCode(finalizationError) === "EEXIST"
      ? `${artifactName} output already exists and was not changed: ${quotePath(outputPath)}`
      : `${artifactName} finalization failed while a different target exists at ${quotePath(outputPath)}: ${errorMessage(finalizationError)}`;
  throw new Error(`${message}. ${cleanup.detail}.`);
}

function publishStage(
  artifactName: string,
  outputPath: string,
  workspace: StagingWorkspace,
  operations: ProtectedOutputOperations,
  beforePublish?: ProtectedOutputOptions["beforePublish"],
): void {
  try {
    beforePublish?.(workspace.temporaryPath, outputPath);
    const boundary = workspaceBoundary(workspace);
    if (boundary.unresolved) throw new Error(boundary.detail);
    operations.link(workspace.temporaryPath, outputPath);
  } catch (error) {
    reconcilePublicationFailure(artifactName, outputPath, workspace, error);
  }

  const targetState = pathState(outputPath);
  const temporaryState = pathState(workspace.temporaryPath);
  if (
    targetState.kind !== "present" ||
    temporaryState.kind !== "present" ||
    !workspace.temporaryIdentity ||
    !sameFile(targetState.metadata, workspace.temporaryIdentity) ||
    !sameFile(temporaryState.metadata, workspace.temporaryIdentity)
  ) {
    throw new Error(
      `${artifactName} link completed for ${quotePath(outputPath)}, but final ownership could not be confirmed. ${stateDetail("Possible output target", outputPath, targetState)}. ${preserveWorkspaceDetail(workspace)}. Inspect the exact paths; do not rerun with this output path.`,
    );
  }

  const cleanup = removeOwnedTemporaryPath(workspace);
  if (cleanup.unresolved) {
    throw new Error(
      `${artifactName} was published at ${quotePath(outputPath)}, but staging cleanup failed. The published output was preserved. ${cleanup.detail}.`,
    );
  }
}

export function writeProtectedOutput(
  requestedOutputPath: string,
  contents: string,
  options: ProtectedOutputOptions,
): string {
  const outputPath = assertProtectedOutputAbsent(requestedOutputPath, options.artifactName);
  const operations = { ...DEFAULT_OPERATIONS, ...options.operations };
  let workspace: StagingWorkspace;
  try {
    workspace = createStagingWorkspace(outputPath, operations, options.beforeCleanup);
  } catch (error) {
    throw new Error(
      `${options.artifactName} staging setup failed for ${quotePath(outputPath)}: ${errorMessage(error)}`,
    );
  }
  stageOutput(contents, workspace, operations);
  publishStage(options.artifactName, outputPath, workspace, operations, options.beforePublish);
  return outputPath;
}
