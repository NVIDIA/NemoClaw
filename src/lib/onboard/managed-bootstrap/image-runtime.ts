// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  applyManagedStartupRootRequest,
  atomicWriteRootFile,
  MANAGED_STARTUP_COMPLETION_FILE,
  MANAGED_STARTUP_RUNTIME_ENV_FILE,
  ManagedStartupImageRuntimeError,
  type ManagedStartupRootApplyResult,
  main as mainManagedStartupImageRuntime,
  readStableRegularFileSnapshot,
  verifyManagedStartupImageCompletion,
} from "../managed-startup/image-runtime";
import { MANAGED_STARTUP_AGENTS, type ManagedStartupAgent } from "../managed-startup/profile";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES,
  MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  type ManagedBootstrapImageCompletion,
  parseManagedBootstrapEnvelope,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";

const SHA256_RE = /^[a-f0-9]{64}$/u;
type Environment = Record<string, string | undefined>;

export interface ManagedBootstrapImageRuntimeExpected {
  readonly agent: ManagedStartupAgent;
  readonly profileFingerprint: string;
  readonly bootstrapIdentity: string;
}

interface ManagedBootstrapEnvelopeSnapshot {
  readonly bootstrapIdentity: string;
  readonly bytes: Buffer;
  readonly request: ManagedStartupRootApplyRequest;
  readonly stat: fs.BigIntStats;
}

export interface ManagedBootstrapEnvelopeClaimPaths {
  readonly directory: string;
  readonly file: string;
  readonly requestFile: string;
}

interface ManagedBootstrapEnvelopeClaim extends ManagedBootstrapEnvelopeClaimPaths {
  readonly bytes: Buffer;
  readonly request: ManagedStartupRootApplyRequest;
  readonly stat: fs.BigIntStats;
}

function fail(message: string): never {
  throw new ManagedStartupImageRuntimeError(message);
}

function requireRoot(): void {
  if (process.geteuid?.() !== 0) {
    fail("managed bootstrap image runtime requires container effective uid 0");
  }
}

function exactAgent(value: string): ManagedStartupAgent {
  if (!MANAGED_STARTUP_AGENTS.includes(value as ManagedStartupAgent)) {
    fail(`unsupported agent ${JSON.stringify(value)}`);
  }
  return value as ManagedStartupAgent;
}

function readExpected(argv: readonly string[]): ManagedBootstrapImageRuntimeExpected {
  if (argv.length !== 7) {
    fail(
      "usage: managed-startup-image-runtime [--recover-bootstrap-claim|--apply-bootstrap-file|--verify-bootstrap-completion|--wait-for-completion] --agent <agent> --profile-fingerprint <sha256> --bootstrap-identity <sha256>",
    );
  }
  const valueAfter = (flag: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0 || index + 1 >= argv.length)
      fail(`managed bootstrap ${flag} argument is missing`);
    return argv[index + 1] as string;
  };
  const profileFingerprint = valueAfter("--profile-fingerprint");
  const bootstrapIdentity = valueAfter("--bootstrap-identity");
  if (!SHA256_RE.test(profileFingerprint) || !SHA256_RE.test(bootstrapIdentity)) {
    fail("managed bootstrap image runtime identities must encode 32 lowercase-hex bytes");
  }
  return {
    agent: exactAgent(valueAfter("--agent")),
    profileFingerprint,
    bootstrapIdentity,
  };
}

function readProtectedManagedBootstrapEnvelopeSnapshot(
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
): ManagedBootstrapEnvelopeSnapshot {
  requireRoot();
  const { bytes, stat } = readStableRegularFileSnapshot(
    requestFile,
    MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES,
  );
  if (!isProtectedManagedBootstrapFile(stat)) {
    fail("managed bootstrap envelope must be root:root mode 0400 with one link");
  }
  const envelope = parseManagedBootstrapEnvelope(bytes.toString("utf8"));
  return {
    bootstrapIdentity: envelope.bootstrapIdentity,
    bytes,
    request: envelope.rootApplyRequest,
    stat,
  };
}

function managedBootstrapEnvelopeMatchesExpected(
  snapshot: ManagedBootstrapEnvelopeSnapshot,
  expected: ManagedBootstrapImageRuntimeExpected,
): boolean {
  return (
    snapshot.bootstrapIdentity === expected.bootstrapIdentity &&
    snapshot.request.agent === expected.agent &&
    snapshot.request.profileFingerprint === expected.profileFingerprint
  );
}

function readManagedBootstrapEnvelopeSnapshot(
  expected: ManagedBootstrapImageRuntimeExpected,
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
): ManagedBootstrapEnvelopeSnapshot {
  const snapshot = readProtectedManagedBootstrapEnvelopeSnapshot(requestFile);
  if (!managedBootstrapEnvelopeMatchesExpected(snapshot, expected)) {
    fail("managed bootstrap envelope identity does not match the replacement");
  }
  return snapshot;
}

export function readManagedBootstrapEnvelope(
  expected: ManagedBootstrapImageRuntimeExpected,
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
): ManagedStartupRootApplyRequest {
  return readManagedBootstrapEnvelopeSnapshot(expected, requestFile).request;
}

export function managedBootstrapEnvelopeClaimPaths(
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
): ManagedBootstrapEnvelopeClaimPaths {
  if (!path.isAbsolute(requestFile)) fail("managed bootstrap request path must be absolute");
  const directory = path.join(
    path.dirname(requestFile),
    `.${path.basename(requestFile)}.nemoclaw-claim`,
  );
  return { directory, file: path.join(directory, "request"), requestFile };
}

function lstatManagedBootstrapPath(target: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail(`could not inspect managed bootstrap path ${target}`);
  }
}

function sameStableManagedBootstrapFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameClaimedManagedBootstrapFile(left, right) && left.ctimeNs === right.ctimeNs;
}

function sameClaimedManagedBootstrapFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function isProtectedManagedBootstrapFile(stat: fs.BigIntStats, expectedLinks = 1n): boolean {
  return (
    stat.isFile() &&
    stat.nlink === expectedLinks &&
    stat.uid === 0n &&
    stat.gid === 0n &&
    Number(stat.mode & 0o777n) === 0o400
  );
}

function requirePrivateManagedBootstrapClaimDirectory(directory: string): void {
  const stat = lstatManagedBootstrapPath(directory);
  if (
    stat === null ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0n ||
    stat.gid !== 0n ||
    Number(stat.mode & 0o777n) !== 0o700
  ) {
    fail("managed bootstrap claim directory must be root:root mode 0700");
  }
}

function removeManagedBootstrapClaimDirectory(directory: string): void {
  try {
    fs.rmdirSync(directory);
  } catch {
    fail("could not remove managed bootstrap claim directory");
  }
}

function requireSafeManagedBootstrapClaimParent(directory: string): void {
  const parent = lstatManagedBootstrapPath(path.dirname(directory));
  if (
    parent === null ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== 0n ||
    parent.gid !== 0n ||
    Number(parent.mode & 0o022n) !== 0
  ) {
    fail("managed bootstrap claim parent must be a protected root-owned directory");
  }
}

function managedBootstrapClaimEntries(directory: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    fail("could not inspect managed bootstrap claim directory contents");
  }
  return entries.sort();
}

function ensurePrivateManagedBootstrapClaimDirectory(directory: string): void {
  requireSafeManagedBootstrapClaimParent(directory);
  const current = lstatManagedBootstrapPath(directory);
  if (current !== null) {
    requirePrivateManagedBootstrapClaimDirectory(directory);
    return;
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chownSync(directory, 0, 0);
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      fail("could not create private managed bootstrap envelope claim");
    }
  }
  requirePrivateManagedBootstrapClaimDirectory(directory);
}

interface OpenManagedBootstrapEnvelopeSnapshot extends ManagedBootstrapEnvelopeSnapshot {
  readonly descriptor: number;
}

function openManagedBootstrapEnvelopeSnapshot(
  expected: ManagedBootstrapImageRuntimeExpected,
  target: string,
): OpenManagedBootstrapEnvelopeSnapshot {
  requireRoot();
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    fail("O_NOFOLLOW is unavailable for managed bootstrap envelope reads");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
  } catch {
    fail(`refusing unsafe or unreadable managed bootstrap envelope ${target}`);
  }

  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !isProtectedManagedBootstrapFile(before) ||
      before.size < 1n ||
      before.size > BigInt(MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES)
    ) {
      fail("managed bootstrap envelope must be a bounded root:root mode 0400 file with one link");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const overflowBytes = fs.readSync(descriptor, overflow, 0, 1, offset);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.length ||
      overflowBytes !== 0 ||
      !sameStableManagedBootstrapFile(before, after)
    ) {
      fail("managed bootstrap envelope changed while it was authenticated");
    }
    const envelope = parseManagedBootstrapEnvelope(bytes.toString("utf8"));
    const snapshot = {
      bootstrapIdentity: envelope.bootstrapIdentity,
      bytes,
      request: envelope.rootApplyRequest,
      stat: after,
    };
    if (!managedBootstrapEnvelopeMatchesExpected(snapshot, expected)) {
      fail("managed bootstrap envelope identity does not match the replacement");
    }
    return { ...snapshot, descriptor };
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the authentication failure.
    }
    throw error;
  }
}

function restoreUnclaimedManagedBootstrapEnvelope(paths: ManagedBootstrapEnvelopeClaimPaths): void {
  try {
    fs.linkSync(paths.file, paths.requestFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail(
        "canonical managed bootstrap request was replaced again; the displaced request remains in the private claim",
      );
    }
    fail("could not restore replacement managed bootstrap envelope to its canonical path");
  }
  try {
    fs.unlinkSync(paths.file);
  } catch {
    fail("could not remove restored managed bootstrap envelope from the private claim");
  }
  removeManagedBootstrapClaimDirectory(paths.directory);
}

function reconcileInterruptedManagedBootstrapRestoration(
  paths: ManagedBootstrapEnvelopeClaimPaths,
): boolean {
  const canonical = lstatManagedBootstrapPath(paths.requestFile);
  const privateClaim = lstatManagedBootstrapPath(paths.file);
  if (
    canonical === null ||
    privateClaim === null ||
    !isProtectedManagedBootstrapFile(canonical, 2n) ||
    !isProtectedManagedBootstrapFile(privateClaim, 2n) ||
    !sameStableManagedBootstrapFile(canonical, privateClaim)
  ) {
    return false;
  }
  try {
    fs.unlinkSync(paths.file);
  } catch {
    fail("could not reconcile interrupted managed bootstrap envelope restoration");
  }
  removeManagedBootstrapClaimDirectory(paths.directory);
  return true;
}

function claimManagedBootstrapEnvelope(
  expected: ManagedBootstrapImageRuntimeExpected,
  requestFile: string,
): ManagedBootstrapEnvelopeClaim {
  const paths = managedBootstrapEnvelopeClaimPaths(requestFile);
  ensurePrivateManagedBootstrapClaimDirectory(paths.directory);
  const entries = managedBootstrapClaimEntries(paths.directory);
  if (entries.length === 1 && entries[0] === path.basename(paths.file)) {
    const resumed = readManagedBootstrapEnvelopeSnapshot(expected, paths.file);
    return { ...paths, ...resumed };
  }
  if (entries.length !== 0) {
    fail("managed bootstrap claim directory contains unexpected entries");
  }

  const opened = openManagedBootstrapEnvelopeSnapshot(expected, requestFile);
  let claimed: ManagedBootstrapEnvelopeSnapshot;
  try {
    try {
      fs.renameSync(requestFile, paths.file);
    } catch {
      fail("could not atomically claim managed bootstrap envelope");
    }
    try {
      const descriptorAfterRename = fs.fstatSync(opened.descriptor, { bigint: true });
      claimed = readManagedBootstrapEnvelopeSnapshot(expected, paths.file);
      if (
        !sameClaimedManagedBootstrapFile(opened.stat, descriptorAfterRename) ||
        !sameStableManagedBootstrapFile(descriptorAfterRename, claimed.stat) ||
        !opened.bytes.equals(claimed.bytes)
      ) {
        fail("managed bootstrap envelope changed before its atomic claim");
      }
    } catch {
      restoreUnclaimedManagedBootstrapEnvelope(paths);
      fail("managed bootstrap envelope changed before its atomic claim");
    }
  } finally {
    try {
      fs.closeSync(opened.descriptor);
    } catch {
      fail("could not close authenticated managed bootstrap envelope");
    }
  }
  return { ...paths, ...claimed };
}

export function recoverManagedBootstrapEnvelopeClaim(
  expected: ManagedBootstrapImageRuntimeExpected,
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
): boolean {
  requireRoot();
  const paths = managedBootstrapEnvelopeClaimPaths(requestFile);
  requireSafeManagedBootstrapClaimParent(paths.directory);
  const directoryStat = lstatManagedBootstrapPath(paths.directory);
  if (directoryStat === null) return false;
  requirePrivateManagedBootstrapClaimDirectory(paths.directory);
  const entries = managedBootstrapClaimEntries(paths.directory);
  if (entries.length === 0) {
    if (lstatManagedBootstrapPath(requestFile) !== null) return true;
    removeManagedBootstrapClaimDirectory(paths.directory);
    return false;
  }
  if (entries.length !== 1 || entries[0] !== path.basename(paths.file)) {
    fail("managed bootstrap claim directory contains unexpected entries");
  }
  if (reconcileInterruptedManagedBootstrapRestoration(paths)) return true;
  const claim = readProtectedManagedBootstrapEnvelopeSnapshot(paths.file);
  if (managedBootstrapEnvelopeMatchesExpected(claim, expected)) return true;
  if (lstatManagedBootstrapPath(requestFile) !== null) {
    fail("managed bootstrap envelope identity does not match the replacement");
  }
  restoreUnclaimedManagedBootstrapEnvelope(paths);
  return true;
}

function consumeManagedBootstrapEnvelopeClaim(
  expected: ManagedBootstrapImageRuntimeExpected,
  claim: ManagedBootstrapEnvelopeClaim,
): void {
  requireSafeManagedBootstrapClaimParent(claim.directory);
  requirePrivateManagedBootstrapClaimDirectory(claim.directory);
  const current = readManagedBootstrapEnvelopeSnapshot(expected, claim.file);
  if (
    !sameStableManagedBootstrapFile(current.stat, claim.stat) ||
    !current.bytes.equals(claim.bytes)
  ) {
    fail("managed bootstrap envelope claim changed before completion cleanup");
  }
  try {
    fs.unlinkSync(claim.file);
  } catch {
    fail("could not consume managed bootstrap envelope claim");
  }
  removeManagedBootstrapClaimDirectory(claim.directory);
}

export async function applyManagedBootstrapEnvelope(
  expected: ManagedBootstrapImageRuntimeExpected,
  env: Environment = process.env,
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
  completionFile: string = MANAGED_BOOTSTRAP_COMPLETION_FILE,
): Promise<ManagedStartupRootApplyResult> {
  const claim = claimManagedBootstrapEnvelope(expected, requestFile);
  const result = await applyManagedStartupRootRequest(claim.request, env, {
    bootstrapIdentity: expected.bootstrapIdentity,
  });
  atomicWriteRootFile(
    completionFile,
    serializeManagedBootstrapImageCompletion({
      agent: result.agent,
      bootstrapIdentity: expected.bootstrapIdentity,
      profileFingerprint: result.fingerprint,
      transactionPending: result.transactionPending,
    }),
    0o444,
  );
  consumeManagedBootstrapEnvelopeClaim(expected, claim);
  return result;
}

export function verifyManagedBootstrapImageCompletion(
  expected: ManagedBootstrapImageRuntimeExpected,
  completionFile: string = MANAGED_BOOTSTRAP_COMPLETION_FILE,
  startupCompletionFile: string = MANAGED_STARTUP_COMPLETION_FILE,
  runtimeEnvironmentFile: string = MANAGED_STARTUP_RUNTIME_ENV_FILE,
): ManagedBootstrapImageCompletion {
  // The sandbox-owned hold is the verifier. Root ownership, one-link
  // regular-file checks, and mode 0444 protect each handoff it consumes.
  const { bytes, stat } = readStableRegularFileSnapshot(
    completionFile,
    MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES,
  );
  if (
    stat.nlink !== 1n ||
    stat.uid !== 0n ||
    stat.gid !== 0n ||
    Number(stat.mode & 0o777n) !== 0o444
  ) {
    fail("managed bootstrap completion must be root:root mode 0444 with one link");
  }
  const completion = parseManagedBootstrapImageCompletion(bytes.toString("utf8"));
  if (
    completion.agent !== expected.agent ||
    completion.profileFingerprint !== expected.profileFingerprint ||
    completion.bootstrapIdentity !== expected.bootstrapIdentity
  ) {
    fail("managed bootstrap completion identity does not match the replacement");
  }
  verifyManagedStartupImageCompletion(
    expected.agent,
    expected.profileFingerprint,
    startupCompletionFile,
    runtimeEnvironmentFile,
  );
  return completion;
}

export function waitForManagedBootstrapImageCompletion(
  expected: ManagedBootstrapImageRuntimeExpected,
  timeoutSeconds = 600,
  completionFile: string = MANAGED_BOOTSTRAP_COMPLETION_FILE,
  startupCompletionFile: string = MANAGED_STARTUP_COMPLETION_FILE,
  runtimeEnvironmentFile: string = MANAGED_STARTUP_RUNTIME_ENV_FILE,
): ManagedBootstrapImageCompletion {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    fail("managed bootstrap completion wait timeout must be an integer from 1 to 3600 seconds");
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    try {
      return verifyManagedBootstrapImageCompletion(
        expected,
        completionFile,
        startupCompletionFile,
        runtimeEnvironmentFile,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        fail(
          `managed bootstrap completion was not published within ${String(timeoutSeconds)} seconds`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "--recover-bootstrap-claim") {
    const expected = readExpected(argv);
    const pending = recoverManagedBootstrapEnvelopeClaim(expected);
    console.log(
      pending
        ? `[managed-startup] found pending ${expected.agent} bootstrap request claim`
        : `[managed-startup] no pending ${expected.agent} bootstrap request claim`,
    );
    return;
  }
  if (argv[0] === "--apply-bootstrap-file") {
    const expected = readExpected(argv);
    const result = await applyManagedBootstrapEnvelope(expected);
    console.log(
      result.transactionPending
        ? `[managed-startup] applied ${result.agent} profile ${result.fingerprint}; transaction pending`
        : `[managed-startup] ${result.agent} profile ${result.fingerprint} was already complete`,
    );
    return;
  }
  if (argv[0] === "--verify-bootstrap-completion") {
    const expected = readExpected(argv);
    const completion = verifyManagedBootstrapImageCompletion(expected);
    console.log(
      `[managed-startup] verified ${expected.agent} profile ${expected.profileFingerprint} bootstrap ${expected.bootstrapIdentity}${
        completion.transactionPending ? "; transaction pending" : ""
      }`,
    );
    return;
  }
  if (argv[0] === "--wait-for-completion") {
    const expected = readExpected(argv);
    const completion = waitForManagedBootstrapImageCompletion(expected);
    console.log(
      `[managed-startup] verified ${expected.agent} profile ${expected.profileFingerprint} bootstrap ${expected.bootstrapIdentity}${
        completion.transactionPending ? "; transaction pending" : ""
      }`,
    );
    return;
  }
  await mainManagedStartupImageRuntime(argv);
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
