// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import { isErrnoException } from "../../core/errno";
import type { PodmanSocketAuthority } from "../../adapters/podman";
import { isMcpLifecycleLockHeld } from "../../state/mcp-lifecycle-lock-acquisition";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../../state/onboard/portable-runtime-authority";
import { portableDemoReceiptPath } from "./portable-runtime-receipt-readiness";

export const HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION = 5 as const;
export const HERMES_PORTABLE_RECEIPT_DIRECTORY = "hermes-portable-lifecycle";

const RECEIPT_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 8;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const GENERATION = /^[A-Za-z0-9._:-]{1,256}$/u;
const SANDBOX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,39})$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type HermesPortableReceiptPhase = "pending" | "configuring" | "active";

export interface HermesPortableStartupContract {
  readonly manifestSha256: string;
  readonly startupDescriptorSha256: string;
  readonly argv: readonly string[];
  readonly gatewayCommand: "hermes gateway run";
  readonly interactiveCommand: "hermes";
  readonly health: {
    readonly url: "http://localhost:8642/health";
    readonly port: 8642;
    readonly method: "GET";
    readonly auth: "bearer_token";
    readonly credentialEnv: "API_SERVER_KEY";
    readonly successStatus: 200;
  };
  readonly devicePairing: false;
  readonly configDir: "/sandbox/.hermes";
  readonly stateIdentitySha256: string;
}

export interface HermesPortablePolicyAuthority {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly intendedSemanticSha256: string;
  readonly sourceIdentity: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mode: 384;
    readonly uid: number;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  };
}

export interface HermesPortableContainerAuthority {
  readonly containerId: string;
  readonly sandboxId: string;
  readonly imageId: string;
  readonly labelsSha256: string;
  readonly name: string;
  readonly running: boolean;
  readonly restartPolicy: string;
}

interface HermesPortableReceiptCommon {
  readonly schemaVersion: typeof HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION;
  readonly agent: "hermes";
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly runtimeAuthority: CheckpointPortableRuntimeAuthority;
  readonly socketAuthority: PodmanSocketAuthority;
  readonly startup: HermesPortableStartupContract;
  readonly policy: HermesPortablePolicyAuthority;
}

export interface HermesPortablePendingReceipt extends HermesPortableReceiptCommon {
  readonly phase: "pending";
}

export interface HermesPortableConfiguredReceipt extends HermesPortableReceiptCommon {
  readonly phase: "configuring" | "active";
  readonly previousPhaseSha256: string;
  readonly verifiedLivePolicySemanticSha256: string;
  readonly container: HermesPortableContainerAuthority;
}

export type HermesPortableLifecycleReceipt =
  | HermesPortablePendingReceipt
  | HermesPortableConfiguredReceipt;

export interface HermesPortableReceiptSnapshot {
  readonly receipt: HermesPortableLifecycleReceipt;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly path: string;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
  };
}

export type PortableAgentReceiptAuthority =
  | { readonly kind: "none" }
  | { readonly kind: "openclaw"; readonly path: string }
  | { readonly kind: "hermes"; readonly snapshot: HermesPortableReceiptSnapshot };

export interface HermesPortableReceiptPublicationHooks {
  readonly assertLifecycleLock?: () => void;
  readonly afterStageCreate?: () => void;
  readonly afterStageWrite?: (written: number, total: number) => void;
  readonly afterStageFsync?: () => void;
  readonly afterCanonicalLink?: () => void;
  readonly afterDirectoryFsync?: () => void;
  readonly afterCleanupLink?: () => void;
  readonly afterStageDetach?: () => void;
  readonly beforeCleanupUnlink?: () => void;
}

export interface HermesPortablePolicySourceSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly identity: fs.BigIntStats;
}

function fail(message: string): never {
  throw new Error(`Hermes portable lifecycle receipt ${message}`);
}

function currentUid(): number {
  if (typeof process.getuid !== "function") fail("requires current-user identity");
  return process.getuid();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeString(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value)
  );
}

function exactAbsolutePath(value: unknown): value is string {
  return safeString(value) && path.isAbsolute(value) && path.normalize(value) === value;
}

function parseStartup(value: unknown): HermesPortableStartupContract {
  const startup = record(value);
  const health = record(startup?.health);
  if (
    !startup ||
    !exactKeys(startup, [
      "argv",
      "configDir",
      "devicePairing",
      "gatewayCommand",
      "health",
      "interactiveCommand",
      "manifestSha256",
      "startupDescriptorSha256",
      "stateIdentitySha256",
    ]) ||
    !health ||
    !exactKeys(health, ["auth", "credentialEnv", "method", "port", "successStatus", "url"]) ||
    !SHA256.test(String(startup.manifestSha256)) ||
    !SHA256.test(String(startup.startupDescriptorSha256)) ||
    !SHA256.test(String(startup.stateIdentitySha256)) ||
    !Array.isArray(startup.argv) ||
    startup.argv.length < 2 ||
    startup.argv.length > 128 ||
    startup.argv.some((argument) => !safeString(argument, 2048)) ||
    startup.gatewayCommand !== "hermes gateway run" ||
    startup.interactiveCommand !== "hermes" ||
    startup.devicePairing !== false ||
    startup.configDir !== "/sandbox/.hermes" ||
    health.url !== "http://localhost:8642/health" ||
    health.port !== 8642 ||
    health.method !== "GET" ||
    health.auth !== "bearer_token" ||
    health.credentialEnv !== "API_SERVER_KEY" ||
    health.successStatus !== 200
  ) {
    fail("has an invalid startup contract");
  }
  return startup as unknown as HermesPortableStartupContract;
}

function parsePolicy(value: unknown): HermesPortablePolicyAuthority {
  const policy = record(value);
  const identity = record(policy?.sourceIdentity);
  if (
    !policy ||
    !exactKeys(policy, [
      "intendedSemanticSha256",
      "sourceIdentity",
      "sourcePath",
      "sourceSha256",
    ]) ||
    !identity ||
    !exactKeys(identity, ["ctimeNs", "dev", "ino", "mode", "mtimeNs", "size", "uid"]) ||
    !exactAbsolutePath(policy.sourcePath) ||
    !SHA256.test(String(policy.sourceSha256)) ||
    !SHA256.test(String(policy.intendedSemanticSha256)) ||
    !DECIMAL.test(String(identity.dev)) ||
    !DECIMAL.test(String(identity.ino)) ||
    !DECIMAL.test(String(identity.size)) ||
    !DECIMAL.test(String(identity.mtimeNs)) ||
    !DECIMAL.test(String(identity.ctimeNs)) ||
    identity.mode !== RECEIPT_MODE ||
    identity.uid !== currentUid()
  ) {
    fail("has invalid policy authority");
  }
  return policy as unknown as HermesPortablePolicyAuthority;
}

function parseContainer(
  value: unknown,
  phase: "configuring" | "active",
): HermesPortableContainerAuthority {
  const container = record(value);
  if (
    !container ||
    !exactKeys(container, [
      "containerId",
      "imageId",
      "labelsSha256",
      "name",
      "restartPolicy",
      "running",
      "sandboxId",
    ]) ||
    !CONTAINER_ID.test(String(container.containerId)) ||
    !GENERATION.test(String(container.sandboxId)) ||
    !IMAGE_ID.test(String(container.imageId)) ||
    !SHA256.test(String(container.labelsSha256)) ||
    !safeString(container.name, 512) ||
    typeof container.running !== "boolean" ||
    !safeString(container.restartPolicy, 128) ||
    (phase === "configuring" && container.running !== true) ||
    (phase === "active" &&
      (container.running !== true || container.restartPolicy !== "unless-stopped"))
  ) {
    fail("has invalid container authority");
  }
  return container as unknown as HermesPortableContainerAuthority;
}

function parseSocketAuthority(
  value: unknown,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
): PodmanSocketAuthority {
  const authority = record(value);
  if (
    !authority ||
    !exactKeys(authority, [
      "device",
      "directoryChain",
      "inode",
      "mode",
      "ownerUid",
      "socketPath",
    ]) ||
    !DECIMAL.test(String(authority.device)) ||
    !DECIMAL.test(String(authority.inode)) ||
    !DECIMAL.test(String(authority.mode)) ||
    authority.ownerUid !== String(currentUid()) ||
    authority.socketPath !== runtimeAuthority.socketPath ||
    !Array.isArray(authority.directoryChain) ||
    authority.directoryChain.length < 1 ||
    authority.directoryChain.length > 64
  ) {
    fail("has invalid Podman socket authority");
  }
  let expectedPath = path.dirname(runtimeAuthority.socketPath);
  for (const value of authority.directoryChain) {
    const directory = record(value);
    if (
      !directory ||
      !exactKeys(directory, ["device", "inode", "mode", "ownerUid", "path"]) ||
      !DECIMAL.test(String(directory.device)) ||
      !DECIMAL.test(String(directory.inode)) ||
      !DECIMAL.test(String(directory.mode)) ||
      !DECIMAL.test(String(directory.ownerUid)) ||
      directory.path !== expectedPath
    ) {
      fail("has invalid Podman socket directory authority");
    }
    expectedPath = path.dirname(expectedPath);
  }
  if (expectedPath !== path.dirname(expectedPath)) {
    fail("has incomplete Podman socket directory authority");
  }
  return authority as unknown as PodmanSocketAuthority;
}

function parseReceiptBytes(bytes: Buffer): HermesPortableLifecycleReceipt {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    fail("is malformed or is not strict UTF-8");
  }
  const receipt = record(value);
  const phase = receipt?.phase;
  const configured = phase === "configuring" || phase === "active";
  const expected = [
    "agent",
    "gatewayName",
    "lifecycleGeneration",
    "phase",
    "policy",
    "runtimeAuthority",
    "sandboxName",
    "schemaVersion",
    "socketAuthority",
    "startup",
    "transactionId",
    ...(configured ? ["container", "previousPhaseSha256", "verifiedLivePolicySemanticSha256"] : []),
  ];
  const authority = parsePortableRuntimeAuthority(receipt?.runtimeAuthority);
  if (
    !receipt ||
    !exactKeys(receipt, expected) ||
    receipt.schemaVersion !== HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION ||
    receipt.agent !== "hermes" ||
    (phase !== "pending" && !configured) ||
    !UUID.test(String(receipt.transactionId)) ||
    !SANDBOX.test(String(receipt.sandboxName)) ||
    !safeString(receipt.gatewayName, 256) ||
    !GENERATION.test(String(receipt.lifecycleGeneration)) ||
    !authority ||
    authority.uid !== currentUid()
  ) {
    fail("has invalid identity fields");
  }
  const common = {
    schemaVersion: HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION,
    agent: "hermes" as const,
    transactionId: receipt.transactionId as string,
    sandboxName: receipt.sandboxName as string,
    gatewayName: receipt.gatewayName as string,
    lifecycleGeneration: receipt.lifecycleGeneration as string,
    runtimeAuthority: authority,
    socketAuthority: parseSocketAuthority(receipt.socketAuthority, authority),
    startup: parseStartup(receipt.startup),
    policy: parsePolicy(receipt.policy),
  };
  if (phase === "pending") return { ...common, phase };
  if (
    !SHA256.test(String(receipt.previousPhaseSha256)) ||
    !SHA256.test(String(receipt.verifiedLivePolicySemanticSha256))
  ) {
    fail("has invalid phase authority");
  }
  return {
    ...common,
    phase,
    previousPhaseSha256: receipt.previousPhaseSha256 as string,
    verifiedLivePolicySemanticSha256: receipt.verifiedLivePolicySemanticSha256 as string,
    container: parseContainer(receipt.container, phase),
  };
}

function serializeReceipt(receipt: HermesPortableLifecycleReceipt): Buffer {
  const normalized = parseReceiptBytes(Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"));
  return Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
}

function receiptHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sandboxReceiptStem(sandboxName: string): string {
  return createHash("sha256").update(sandboxName).digest("hex");
}

export function hermesPortableReceiptRoot(stateDir: string): string {
  return path.join(stateDir, HERMES_PORTABLE_RECEIPT_DIRECTORY);
}

export function hermesPortableReceiptDirectory(sandboxName: string, stateDir: string): string {
  return path.join(hermesPortableReceiptRoot(stateDir), sandboxReceiptStem(sandboxName));
}

function phasePath(directory: string, phase: HermesPortableReceiptPhase): string {
  return path.join(directory, `${phase}.json`);
}

function policySourceBasename(transactionId: string): string {
  if (!UUID.test(transactionId)) fail("has an invalid policy transaction identity");
  return `policy.${transactionId}.yaml`;
}

export function hermesPortablePolicySourcePath(
  sandboxName: string,
  transactionId: string,
  stateDir: string,
): string {
  return path.join(
    hermesPortableReceiptDirectory(sandboxName, stateDir),
    policySourceBasename(transactionId),
  );
}

function policyPublicationTransactionId(entry: string): string | null {
  const match = /^(?:\.?)policy\.([a-f0-9-]{36})(?:\.yaml|\.next(?:\.cleanup)?)$/u.exec(entry);
  return match && UUID.test(match[1]!) ? match[1]! : null;
}

function stagePath(
  directory: string,
  phase: HermesPortableReceiptPhase,
  transactionId: string,
): string {
  return path.join(directory, `.${phase}.${transactionId}.next`);
}

function cleanupPath(target: string): string {
  return `${target}.cleanup`;
}

function sameDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function validDirectoryLinkCount(identity: fs.BigIntStats): boolean {
  return identity.nlink >= 1n && identity.nlink <= BigInt(MAX_DIRECTORY_ENTRIES + 2);
}

interface OpenReceiptDirectory {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: fs.BigIntStats;
}

function validateDirectory(directory: string): OpenReceiptDirectory {
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryFlag = fs.constants.O_DIRECTORY;
  if (typeof noFollow !== "number" || typeof directoryFlag !== "number") {
    fail("requires O_NOFOLLOW and O_DIRECTORY");
  }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryFlag);
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(directory, { bigint: true });
    if (
      !identity.isDirectory() ||
      named.isSymbolicLink() ||
      !sameDirectoryIdentity(identity, named) ||
      identity.uid !== BigInt(currentUid()) ||
      (identity.mode & 0o777n) !== BigInt(DIRECTORY_MODE) ||
      !validDirectoryLinkCount(identity) ||
      !validDirectoryLinkCount(named)
    ) {
      fail(`directory is unsafe: ${directory}`);
    }
    return { path: directory, descriptor, identity };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function revalidateDirectory(directory: OpenReceiptDirectory): void {
  const descriptor = fs.fstatSync(directory.descriptor, { bigint: true });
  const named = fs.lstatSync(directory.path, { bigint: true });
  if (
    !sameDirectoryIdentity(directory.identity, descriptor) ||
    !sameDirectoryIdentity(directory.identity, named) ||
    !validDirectoryLinkCount(descriptor) ||
    !validDirectoryLinkCount(named)
  ) {
    fail(`directory changed while in use: ${directory.path}`);
  }
}

function ensurePrivateDirectory(directory: string): OpenReceiptDirectory {
  try {
    fs.mkdirSync(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
  }
  return validateDirectory(directory);
}

function ensureReceiptDirectory(sandboxName: string, stateDir: string): OpenReceiptDirectory {
  const root = hermesPortableReceiptRoot(stateDir);
  const rootDirectory = ensurePrivateDirectory(root);
  try {
    revalidateDirectory(rootDirectory);
    return ensurePrivateDirectory(hermesPortableReceiptDirectory(sandboxName, stateDir));
  } finally {
    fs.closeSync(rootDirectory.descriptor);
  }
}

interface ExactFile {
  readonly bytes: Buffer;
  readonly identity: fs.BigIntStats;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readExactFile(
  target: string,
  allowedLinks = 1n,
  maximumBytes = MAX_RECEIPT_BYTES,
  minimumBytes = 1n,
): ExactFile | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") fail("requires O_NOFOLLOW");
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow | nonblock);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(target, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      !sameFileIdentity(before, named) ||
      before.uid !== BigInt(currentUid()) ||
      (before.mode & 0o777n) !== BigInt(RECEIPT_MODE) ||
      before.nlink !== allowedLinks ||
      before.size < minimumBytes ||
      before.size > BigInt(maximumBytes)
    ) {
      fail(`file is unsafe: ${target}`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`file ended during read: ${target}`);
      offset += count;
    }
    if (!sameFileIdentity(before, fs.fstatSync(descriptor, { bigint: true }))) {
      fail(`file changed during read: ${target}`);
    }
    return { bytes, identity: before };
  } finally {
    fs.closeSync(descriptor);
  }
}

function policyAuthorityFromFile(
  target: string,
  file: ExactFile,
  intendedSemanticSha256: string,
): HermesPortablePolicyAuthority {
  if (!SHA256.test(intendedSemanticSha256)) fail("has an invalid intended policy digest");
  try {
    UTF8.decode(file.bytes);
  } catch {
    fail("policy source is not strict UTF-8");
  }
  return {
    sourcePath: target,
    sourceSha256: receiptHash(file.bytes),
    intendedSemanticSha256,
    sourceIdentity: {
      dev: String(file.identity.dev),
      ino: String(file.identity.ino),
      size: String(file.identity.size),
      mode: RECEIPT_MODE,
      uid: currentUid(),
      mtimeNs: String(file.identity.mtimeNs),
      ctimeNs: String(file.identity.ctimeNs),
    },
  };
}

function samePolicyIdentity(authority: HermesPortablePolicyAuthority, file: ExactFile): boolean {
  return (
    authority.sourceSha256 === receiptHash(file.bytes) &&
    authority.sourceIdentity.dev === String(file.identity.dev) &&
    authority.sourceIdentity.ino === String(file.identity.ino) &&
    authority.sourceIdentity.size === String(file.identity.size) &&
    authority.sourceIdentity.mode === RECEIPT_MODE &&
    authority.sourceIdentity.uid === currentUid() &&
    authority.sourceIdentity.mtimeNs === String(file.identity.mtimeNs) &&
    authority.sourceIdentity.ctimeNs === String(file.identity.ctimeNs)
  );
}

export function captureHermesPortablePolicySource(
  sourcePath: string,
): HermesPortablePolicySourceSnapshot {
  if (!exactAbsolutePath(sourcePath)) fail("policy source path is invalid");
  const file = readExactFile(sourcePath, 1n, MAX_POLICY_BYTES);
  if (!file) fail(`policy source is missing: ${sourcePath}`);
  try {
    UTF8.decode(file.bytes);
  } catch {
    fail("policy source is not strict UTF-8");
  }
  return {
    path: sourcePath,
    bytes: file.bytes,
    sha256: receiptHash(file.bytes),
    identity: file.identity,
  };
}

export function assertHermesPortablePolicySourceSnapshot(
  snapshot: HermesPortablePolicySourceSnapshot,
): void {
  const current = captureHermesPortablePolicySource(snapshot.path);
  if (
    current.sha256 !== snapshot.sha256 ||
    !current.bytes.equals(snapshot.bytes) ||
    !sameFileIdentity(current.identity, snapshot.identity)
  ) {
    fail("policy source changed while in custody");
  }
}

export function assertHermesPortableDurablePolicyAuthority(
  authority: HermesPortablePolicyAuthority,
): Buffer {
  const file = readExactFile(authority.sourcePath, 1n, MAX_POLICY_BYTES);
  if (!file || !samePolicyIdentity(authority, file)) {
    fail("durable policy source disagrees with its receipt authority");
  }
  try {
    UTF8.decode(file.bytes);
  } catch {
    fail("durable policy source is not strict UTF-8");
  }
  return file.bytes;
}

function writeStage(
  target: string,
  bytes: Buffer,
  hooks: HermesPortableReceiptPublicationHooks,
): void {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    RECEIPT_MODE,
  );
  try {
    fs.fchmodSync(descriptor, RECEIPT_MODE);
    hooks.afterStageCreate?.();
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("stage write did not make progress");
      offset += count;
      hooks.afterStageWrite?.(offset, bytes.length);
    }
    fs.fsyncSync(descriptor);
    hooks.afterStageFsync?.();
  } finally {
    fs.closeSync(descriptor);
    // Preserve an incomplete private generation. An identical publisher can
    // retire it under the lifecycle lock; an ordinary reader fails closed.
  }
}

function retireInterruptedEmptyStage(
  canonical: string,
  staged: string,
  cleanup: string,
  directory: OpenReceiptDirectory,
  assertLifecycleLock: () => void,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  if (stageLinkCount(staged) !== 1n) return;
  const empty = readExactFile(staged, 1n, maximumBytes, 0n);
  if (!empty || empty.bytes.length !== 0) return;
  if (stageLinkCount(canonical) !== null || stageLinkCount(cleanup) !== null) {
    fail("empty stage conflicts with other publication evidence");
  }
  assertLifecycleLock();
  revalidateDirectory(directory);
  const current = readExactFile(staged, 1n, maximumBytes, 0n);
  if (!current || !sameArtifact(empty, current) || current.bytes.length !== 0) {
    fail("empty stage changed before exact retirement");
  }
  fs.unlinkSync(staged);
  fs.fsyncSync(directory.descriptor);
}

function readPublicationArtifact(
  target: string,
  maximumBytes = MAX_RECEIPT_BYTES,
): ExactFile | null {
  const links = stageLinkCount(target);
  if (links === null) return null;
  if (links < 1n || links > 3n) fail(`publication artifact has invalid links: ${target}`);
  return readExactFile(target, links, maximumBytes);
}

function sameArtifact(left: ExactFile, right: ExactFile): boolean {
  return (
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.bytes.equals(right.bytes)
  );
}

function unlinkExactArtifact(
  target: string,
  expected: ExactFile,
  beforeUnlink?: () => void,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  beforeUnlink?.();
  const current = readPublicationArtifact(target, maximumBytes);
  if (!current || !sameArtifact(current, expected)) {
    fail("artifact changed before exact detach");
  }
  fs.unlinkSync(target);
}

function detachPublishedStage(
  canonical: string,
  staged: string,
  cleanup: string,
  expectedBytes: Buffer,
  hooks: HermesPortableReceiptPublicationHooks,
  maximumBytes = MAX_RECEIPT_BYTES,
): void {
  const canonicalFile = readPublicationArtifact(canonical, maximumBytes);
  const stagedFile = readPublicationArtifact(staged, maximumBytes);
  if (!canonicalFile || !stagedFile) fail("publication is missing canonical or staged authority");
  if (
    !sameArtifact(canonicalFile, stagedFile) ||
    !canonicalFile.bytes.equals(expectedBytes) ||
    !stagedFile.bytes.equals(expectedBytes)
  ) {
    fail("publication artifacts disagree");
  }
  const existingCleanup = readPublicationArtifact(cleanup, maximumBytes);
  if (existingCleanup) {
    if (!sameArtifact(canonicalFile, existingCleanup)) fail("cleanup artifact disagrees");
  } else {
    fs.linkSync(staged, cleanup);
    hooks.afterCleanupLink?.();
  }
  const linkedStage = readPublicationArtifact(staged, maximumBytes);
  if (!linkedStage || !sameArtifact(canonicalFile, linkedStage)) {
    fail("staged authority changed before detach");
  }
  unlinkExactArtifact(staged, linkedStage, undefined, maximumBytes);
  hooks.afterStageDetach?.();
  const linkedCleanup = readPublicationArtifact(cleanup, maximumBytes);
  if (!linkedCleanup || !sameArtifact(canonicalFile, linkedCleanup)) {
    fail("cleanup authority changed before detach");
  }
  unlinkExactArtifact(cleanup, linkedCleanup, hooks.beforeCleanupUnlink, maximumBytes);
}

function reconcilePublicationArtifacts(
  canonical: string,
  staged: string,
  cleanup: string,
  expectedBytes: Buffer,
  hooks: HermesPortableReceiptPublicationHooks,
  maximumBytes = MAX_RECEIPT_BYTES,
): "complete" | "staged" | "absent" {
  const canonicalFile = readPublicationArtifact(canonical, maximumBytes);
  const stagedFile = readPublicationArtifact(staged, maximumBytes);
  const cleanupFile = readPublicationArtifact(cleanup, maximumBytes);
  const artifacts = [canonicalFile, stagedFile, cleanupFile].filter(
    (artifact): artifact is ExactFile => artifact !== null,
  );
  if (artifacts.some((artifact) => !artifact.bytes.equals(expectedBytes))) {
    if (canonicalFile || artifacts.length > 1) fail("publication artifacts disagree");
    unlinkExactArtifact(stagedFile ? staged : cleanup, artifacts[0]!, undefined, maximumBytes);
    return "absent";
  }
  if (
    artifacts.length > 1 &&
    artifacts.some((artifact) => !sameArtifact(artifacts[0]!, artifact))
  ) {
    fail("publication artifacts have different generations");
  }
  if (canonicalFile) {
    if (stagedFile) {
      detachPublishedStage(canonical, staged, cleanup, expectedBytes, hooks, maximumBytes);
    } else if (cleanupFile) {
      unlinkExactArtifact(cleanup, cleanupFile, hooks.beforeCleanupUnlink, maximumBytes);
    }
    return "complete";
  }
  if (stagedFile && cleanupFile) {
    unlinkExactArtifact(cleanup, cleanupFile, undefined, maximumBytes);
    return "staged";
  }
  if (cleanupFile) {
    fs.linkSync(cleanup, staged);
    const restored = readPublicationArtifact(staged, maximumBytes);
    if (!restored || !sameArtifact(cleanupFile, restored))
      fail("could not restore staged authority");
    unlinkExactArtifact(cleanup, cleanupFile, undefined, maximumBytes);
    return "staged";
  }
  return stagedFile ? "staged" : "absent";
}

function stageLinkCount(target: string): bigint | null {
  try {
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`publication artifact is unsafe: ${target}`);
    return stat.nlink;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Copy an exact temporary create policy into private durable transaction custody. */
export function publishHermesPortableDurablePolicySource(input: {
  readonly sandboxName: string;
  readonly transactionId: string;
  readonly stateDir: string;
  readonly intendedSemanticSha256: string;
  readonly source: HermesPortablePolicySourceSnapshot;
  readonly hooks?: HermesPortableReceiptPublicationHooks;
}): HermesPortablePolicyAuthority {
  const hooks = input.hooks ?? {};
  const assertLifecycleLock =
    hooks.assertLifecycleLock ??
    (() => {
      if (!isMcpLifecycleLockHeld(input.sandboxName, path.join(input.stateDir, "state"))) {
        fail(`policy publication requires the sandbox lifecycle lock for '${input.sandboxName}'`);
      }
    });
  assertLifecycleLock();
  assertHermesPortablePolicySourceSnapshot(input.source);
  if (existingPath(portableDemoReceiptPath(input.sandboxName, input.stateDir))) {
    fail(`will not reserve policy over OpenClaw authority for '${input.sandboxName}'`);
  }
  const directory = ensureReceiptDirectory(input.sandboxName, input.stateDir);
  const target = hermesPortablePolicySourcePath(
    input.sandboxName,
    input.transactionId,
    input.stateDir,
  );
  const staged = path.join(directory.path, `.policy.${input.transactionId}.next`);
  const cleanup = cleanupPath(staged);
  try {
    revalidateDirectory(directory);
    assertLifecycleLock();
    const allowedEntries = new Set([
      "active.json",
      "configuring.json",
      "pending.json",
      path.basename(target),
      path.basename(staged),
      path.basename(cleanup),
    ]);
    const unexpected = fs.readdirSync(directory.path).filter((entry) => !allowedEntries.has(entry));
    if (unexpected.length > 0) {
      fail(`directory contains other policy authority for '${input.sandboxName}'`);
    }
    const canonical = readPublicationArtifact(target, MAX_POLICY_BYTES);
    if (canonical?.identity.nlink === 1n) {
      if (!canonical.bytes.equals(input.source.bytes))
        fail("durable policy already has other bytes");
      assertHermesPortablePolicySourceSnapshot(input.source);
      return policyAuthorityFromFile(target, canonical, input.intendedSemanticSha256);
    }
    retireInterruptedEmptyStage(
      target,
      staged,
      cleanup,
      directory,
      assertLifecycleLock,
      MAX_POLICY_BYTES,
    );
    const disposition = reconcilePublicationArtifacts(
      target,
      staged,
      cleanup,
      input.source.bytes,
      hooks,
      MAX_POLICY_BYTES,
    );
    const reconciled = readExactFile(target, 1n, MAX_POLICY_BYTES);
    if (reconciled) {
      if (!reconciled.bytes.equals(input.source.bytes)) fail("durable policy has other authority");
      assertHermesPortablePolicySourceSnapshot(input.source);
      fs.fsyncSync(directory.descriptor);
      return policyAuthorityFromFile(target, reconciled, input.intendedSemanticSha256);
    }
    if (disposition === "complete") fail("completed policy publication has no readable authority");
    if (disposition === "absent") writeStage(staged, input.source.bytes, hooks);
    revalidateDirectory(directory);
    assertHermesPortablePolicySourceSnapshot(input.source);
    try {
      fs.linkSync(staged, target);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const raced = readExactFile(target, 1n, MAX_POLICY_BYTES);
      if (!raced || !raced.bytes.equals(input.source.bytes)) {
        fail("durable policy publication raced other authority");
      }
    }
    hooks.afterCanonicalLink?.();
    assertLifecycleLock();
    fs.fsyncSync(directory.descriptor);
    hooks.afterDirectoryFsync?.();
    detachPublishedStage(target, staged, cleanup, input.source.bytes, hooks, MAX_POLICY_BYTES);
    assertLifecycleLock();
    assertHermesPortablePolicySourceSnapshot(input.source);
    fs.fsyncSync(directory.descriptor);
    const published = readExactFile(target, 1n, MAX_POLICY_BYTES);
    if (!published || !published.bytes.equals(input.source.bytes)) {
      fail("durable policy publication did not preserve exact bytes");
    }
    return policyAuthorityFromFile(target, published, input.intendedSemanticSha256);
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

/**
 * Find one private policy generation whose pending receipt was not yet linked.
 * The caller must resume it with the exact current policy bytes under the same
 * sandbox lifecycle lock. Receipt readers continue to reject this state.
 */
export function recoverableHermesPortablePolicyTransactionId(
  sandboxName: string,
  stateDir: string,
): string | null {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    fail(`policy recovery requires the sandbox lifecycle lock for '${sandboxName}'`);
  }
  const directoryPath = hermesPortableReceiptDirectory(sandboxName, stateDir);
  let directory: OpenReceiptDirectory;
  try {
    directory = validateDirectory(directoryPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const entries = fs.readdirSync(directory.path).sort();
    if (entries.length === 0 || entries.some((entry) => entry.endsWith(".json"))) return null;
    const transactionIds = entries.map(policyPublicationTransactionId);
    if (
      entries.length > 3 ||
      transactionIds.some((transactionId) => transactionId === null) ||
      new Set(transactionIds).size !== 1
    ) {
      fail(`directory has ambiguous pre-receipt policy authority for '${sandboxName}'`);
    }
    revalidateDirectory(directory);
    return transactionIds[0]!;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

function validateReceiptPolicySource(
  directoryPath: string,
  receipt: HermesPortableLifecycleReceipt,
): void {
  const expected = path.join(directoryPath, policySourceBasename(receipt.transactionId));
  if (receipt.policy.sourcePath !== expected) fail("policy source path is outside receipt custody");
  assertHermesPortableDurablePolicyAuthority(receipt.policy);
}

function readPhase(
  directory: string,
  phase: HermesPortableReceiptPhase,
): HermesPortableReceiptSnapshot | null {
  const target = phasePath(directory, phase);
  const file = readExactFile(target);
  if (!file) return null;
  const receipt = parseReceiptBytes(file.bytes);
  if (receipt.phase !== phase) fail(`phase file '${phase}' contains another phase`);
  return {
    receipt,
    bytes: file.bytes,
    sha256: receiptHash(file.bytes),
    path: target,
    identity: { dev: file.identity.dev, ino: file.identity.ino },
  };
}

function sameTransaction(
  left: HermesPortableLifecycleReceipt,
  right: HermesPortableLifecycleReceipt,
): boolean {
  const transactionAuthority = (receipt: HermesPortableLifecycleReceipt) => {
    if (receipt.phase === "pending") {
      const { phase: _phase, ...common } = receipt;
      return common;
    }
    const {
      phase: _phase,
      container: _container,
      previousPhaseSha256: _previous,
      verifiedLivePolicySemanticSha256: _verified,
      ...common
    } = receipt;
    return common;
  };
  return isDeepStrictEqual(transactionAuthority(left), transactionAuthority(right));
}

/** Read the highest complete Hermes phase. Any unknown or interrupted artifact blocks. */
export function readHermesPortableLifecycleReceipt(
  sandboxName: string,
  stateDir: string,
): HermesPortableReceiptSnapshot | null {
  const directoryPath = hermesPortableReceiptDirectory(sandboxName, stateDir);
  let directory: OpenReceiptDirectory;
  try {
    directory = validateDirectory(directoryPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const entries = fs.readdirSync(directory.path).sort();
    const completePolicy = /^policy\.[a-f0-9-]{36}\.yaml$/u;
    if (
      entries.length > MAX_DIRECTORY_ENTRIES ||
      entries.some(
        (entry) =>
          !["active.json", "configuring.json", "pending.json"].includes(entry) &&
          !completePolicy.test(entry),
      )
    ) {
      fail(`directory contains incomplete or unknown publication evidence for '${sandboxName}'`);
    }
    const pending = readPhase(directoryPath, "pending");
    const configuring = readPhase(directoryPath, "configuring");
    const active = readPhase(directoryPath, "active");
    if (!pending) {
      if (entries.length > 0) {
        fail(`directory contains incomplete or unknown publication evidence for '${sandboxName}'`);
      }
      revalidateDirectory(directory);
      return null;
    }
    const allowedEntries = new Set([
      "active.json",
      "configuring.json",
      "pending.json",
      policySourceBasename(pending.receipt.transactionId),
    ]);
    if (entries.some((entry) => !allowedEntries.has(entry))) {
      fail(`directory contains incomplete or unknown publication evidence for '${sandboxName}'`);
    }
    validateReceiptPolicySource(directoryPath, pending.receipt);
    revalidateDirectory(directory);
    if (!configuring && active) fail("phase chain is missing configuring authority");
    if (pending.receipt.sandboxName !== sandboxName)
      fail("sandbox identity does not match its path");
    if (configuring) {
      if (
        configuring.receipt.phase !== "configuring" ||
        configuring.receipt.previousPhaseSha256 !== pending.sha256 ||
        !sameTransaction(pending.receipt, configuring.receipt)
      ) {
        fail("configuring phase does not extend pending authority");
      }
    }
    if (active) {
      if (!configuring) fail("active phase has no configuring authority");
      const configuringReceipt = configuring.receipt;
      const activeReceipt = active.receipt;
      if (configuringReceipt.phase !== "configuring" || activeReceipt.phase !== "active") {
        fail("active phase files contain invalid phase authority");
      }
      if (
        activeReceipt.previousPhaseSha256 !== configuring.sha256 ||
        !sameTransaction(configuringReceipt, activeReceipt) ||
        activeReceipt.container.containerId !== configuringReceipt.container.containerId ||
        activeReceipt.container.sandboxId !== configuringReceipt.container.sandboxId ||
        activeReceipt.container.imageId !== configuringReceipt.container.imageId ||
        activeReceipt.verifiedLivePolicySemanticSha256 !==
          configuringReceipt.verifiedLivePolicySemanticSha256
      ) {
        fail("active phase does not extend configuring authority");
      }
    }
    return active ?? configuring ?? pending;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

/** Publish one immutable phase without replacing an earlier phase generation. */
export function publishHermesPortableLifecycleReceipt(
  receipt: HermesPortableLifecycleReceipt,
  stateDir: string,
  hooks: HermesPortableReceiptPublicationHooks = {},
): HermesPortableReceiptSnapshot {
  const bytes = serializeReceipt(receipt);
  const assertLifecycleLock =
    hooks.assertLifecycleLock ??
    (() => {
      if (!isMcpLifecycleLockHeld(receipt.sandboxName, path.join(stateDir, "state"))) {
        fail(`publication requires the sandbox lifecycle lock for '${receipt.sandboxName}'`);
      }
    });
  assertLifecycleLock();
  if (existingPath(portableDemoReceiptPath(receipt.sandboxName, stateDir))) {
    fail(`will not publish over OpenClaw authority for '${receipt.sandboxName}'`);
  }
  const directory = ensureReceiptDirectory(receipt.sandboxName, stateDir);
  const target = phasePath(directory.path, receipt.phase);
  const staged = stagePath(directory.path, receipt.phase, receipt.transactionId);
  const cleanup = cleanupPath(staged);
  try {
    revalidateDirectory(directory);
    assertLifecycleLock();
    const allowedEntries = new Set([
      "active.json",
      "configuring.json",
      "pending.json",
      policySourceBasename(receipt.transactionId),
      path.basename(staged),
      path.basename(cleanup),
    ]);
    const unexpected = fs.readdirSync(directory.path).filter((entry) => !allowedEntries.has(entry));
    if (unexpected.length > 0) {
      fail(`directory contains other publication evidence for '${receipt.sandboxName}'`);
    }
    const prior =
      receipt.phase === "pending"
        ? null
        : readPhase(directory.path, receipt.phase === "configuring" ? "pending" : "configuring");
    if (receipt.phase !== "pending") {
      if (!prior || receipt.previousPhaseSha256 !== prior.sha256) {
        fail(`${receipt.phase} publication does not match its prior phase`);
      }
      if (!sameTransaction(prior.receipt, receipt)) fail("phase transaction changed");
    }

    const completeCanonical = readPublicationArtifact(target);
    const existing =
      completeCanonical?.identity.nlink === 1n ? readPhase(directory.path, receipt.phase) : null;
    if (existing) {
      if (!existing.bytes.equals(bytes)) fail(`${receipt.phase} phase already has other authority`);
      fs.fsyncSync(directory.descriptor);
      return readPhase(directory.path, receipt.phase)!;
    }

    retireInterruptedEmptyStage(target, staged, cleanup, directory, assertLifecycleLock);
    const disposition = reconcilePublicationArtifacts(target, staged, cleanup, bytes, hooks);
    const reconciled = readPhase(directory.path, receipt.phase);
    if (reconciled) {
      if (!reconciled.bytes.equals(bytes)) fail(`${receipt.phase} phase has other authority`);
      fs.fsyncSync(directory.descriptor);
      return reconciled;
    }

    if (disposition === "complete") fail("completed publication has no readable phase");
    if (disposition === "absent") {
      writeStage(staged, bytes, hooks);
    }
    revalidateDirectory(directory);
    try {
      fs.linkSync(staged, target);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
      const raced = readPhase(directory.path, receipt.phase);
      if (!raced || !raced.bytes.equals(bytes)) fail("phase publication raced other authority");
    }
    hooks.afterCanonicalLink?.();
    assertLifecycleLock();
    fs.fsyncSync(directory.descriptor);
    hooks.afterDirectoryFsync?.();
    detachPublishedStage(target, staged, cleanup, bytes, hooks);
    assertLifecycleLock();
    fs.fsyncSync(directory.descriptor);
    return readPhase(directory.path, receipt.phase)!;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

function existingPath(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`legacy receipt path is unsafe: ${target}`);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Select receipt authority by durable agent identity and reject duplicate ownership. */
export function inspectPortableAgentReceiptAuthority(
  sandboxName: string,
  stateDir: string,
): PortableAgentReceiptAuthority {
  const legacyPath = portableDemoReceiptPath(sandboxName, stateDir);
  const openclaw = existingPath(legacyPath);
  const hermes = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
  if (openclaw && hermes) fail(`agent authority is ambiguous for '${sandboxName}'`);
  if (hermes) return { kind: "hermes", snapshot: hermes };
  if (openclaw) return { kind: "openclaw", path: legacyPath };
  return { kind: "none" };
}

export function createHermesPortableTransactionId(): string {
  return randomUUID();
}

export const hermesPortableReceiptInternals = {
  parseReceiptBytes,
  phasePath,
  stagePath,
};
