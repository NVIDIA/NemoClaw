// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  decodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_PROFILE_MAX_BYTES,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
  serializeManagedStartupProfile,
  validateManagedStartupProfile,
} from "./profile";

export const MANAGED_STARTUP_APPLICATION_STATE_DIR = "/var/lib/nemoclaw/startup-profile";
export const MANAGED_STARTUP_CA_MAX_BYTES = 128 * 1024;
export const MANAGED_STARTUP_CA_MAX_CERTIFICATES = 24;

const STATE_SCHEMA_VERSION = 1 as const;
const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const MAX_CONTROL_FILE_BYTES = 512;
const MAX_STATE_ENTRIES = 32;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const GENERATION_RE = /^generation-([a-f0-9]{64})$/u;
const PREPARE_TEMP_RE = /^\.prepare-[0-9]+-[a-f0-9]{24}$/u;
const CONTROL_TEMP_RE = /^\.(?:committed|pending)\.json-[a-f0-9]{24}\.tmp$/u;
const PEM_CERTIFICATE_RE =
  /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/gu;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface ManagedStartupApplicationRuntime {
  readonly rootUid: number;
  readonly rootGid: number;
}

const DEFAULT_RUNTIME: ManagedStartupApplicationRuntime = {
  rootUid: 0,
  rootGid: 0,
};

/**
 * Explicit filesystem seam for unit tests that cannot create uid-0 files.
 * Image entrypoints must omit this argument so uid/gid 0 remain mandatory.
 */
export interface ManagedStartupApplicationTestRuntime {
  readonly rootUid: number;
  readonly rootGid: number;
}

export interface PrepareManagedStartupApplicationInput {
  readonly encodedProfile: string;
  readonly expectedAgent: ManagedStartupAgent;
  readonly corporateCaB64?: string;
  readonly stateDirectory?: string;
}

export interface PreparedManagedStartupApplication {
  readonly status: "prepared" | "already-committed";
  readonly stateDirectory: string;
  readonly generationDirectory: string;
  readonly profilePath: string;
  readonly corporateCaPath: string | null;
  readonly fingerprint: string;
  readonly expectedAgent: ManagedStartupAgent;
  readonly profile: ManagedStartupProfile;
}

export interface CommittedManagedStartupApplication
  extends Omit<PreparedManagedStartupApplication, "status"> {
  readonly status: "committed";
}

interface StateControl {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly fingerprint: string;
  readonly generation: string;
}

interface ValidatedGeneration {
  readonly directory: string;
  readonly profilePath: string;
  readonly corporateCaPath: string | null;
  readonly profile: ManagedStartupProfile;
  readonly fingerprint: string;
}

export class ManagedStartupApplicationError extends Error {
  constructor(message: string) {
    super(`Managed startup application failed: ${message}`);
    this.name = "ManagedStartupApplicationError";
  }
}

function fail(message: string): never {
  throw new ManagedStartupApplicationError(message);
}

function runtimeFor(
  override: ManagedStartupApplicationTestRuntime | undefined,
): ManagedStartupApplicationRuntime {
  return override ?? DEFAULT_RUNTIME;
}

function requireContainerRoot(): void {
  if (process.geteuid?.() !== 0) {
    fail("the image-side applicator must run with effective uid 0");
  }
}

function modeOf(stat: fs.Stats): number {
  return stat.mode & 0o777;
}

function requireOwner(stat: fs.Stats, target: string, runtime: ManagedStartupApplicationRuntime) {
  if (stat.uid !== runtime.rootUid || stat.gid !== runtime.rootGid) {
    fail(`${target} must be owned by root:root`);
  }
}

function requireSecureDirectory(
  target: string,
  runtime: ManagedStartupApplicationRuntime,
  exactMode: boolean,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    fail(`state directory component is missing or unreadable: ${target}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`state directory component must be a real directory: ${target}`);
  }
  const runtimeOwned = stat.uid === runtime.rootUid && stat.gid === runtime.rootGid;
  const systemRootOwned = stat.uid === 0 && stat.gid === 0;
  if (exactMode) {
    requireOwner(stat, target, runtime);
  } else if (!runtimeOwned && !systemRootOwned) {
    fail(`state directory ancestor is not owned by a trusted identity: ${target}`);
  }
  const mode = modeOf(stat);
  const writableByUntrustedIdentity = (mode & 0o022) !== 0;
  const trustedStickyRoot = (stat.mode & 0o1000) !== 0 && (runtimeOwned || systemRootOwned);
  if (
    (exactMode && mode !== STATE_DIRECTORY_MODE) ||
    (!exactMode && writableByUntrustedIdentity && !trustedStickyRoot)
  ) {
    fail(
      exactMode
        ? `${target} must have mode 0700`
        : `${target} is a replaceable group- or world-writable ancestor`,
    );
  }
}

function requireSecureAncestors(target: string, runtime: ManagedStartupApplicationRuntime): void {
  const root = path.parse(target).root;
  let current = root;
  requireSecureDirectory(current, runtime, false);
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fail(`state directory component is missing or unreadable: ${current}`);
    }
    if (stat.isSymbolicLink()) {
      const runtimeOwned = stat.uid === runtime.rootUid && stat.gid === runtime.rootGid;
      const systemRootOwned = stat.uid === 0 && stat.gid === 0;
      if (!runtimeOwned && !systemRootOwned) {
        fail(`state directory ancestor is a replaceable symlink: ${current}`);
      }
      let resolved: string;
      try {
        resolved = fs.realpathSync(current);
      } catch {
        fail(`state directory symlink is missing or unreadable: ${current}`);
      }
      requireSecureAncestors(resolved, runtime);
      continue;
    }
    requireSecureDirectory(current, runtime, false);
  }
}

function ensureStateDirectory(
  rawStateDirectory: string | undefined,
  runtime: ManagedStartupApplicationRuntime,
): string {
  const stateDirectory = rawStateDirectory ?? MANAGED_STARTUP_APPLICATION_STATE_DIR;
  if (!path.isAbsolute(stateDirectory) || stateDirectory.includes("\0")) {
    fail("stateDirectory must be an absolute path");
  }
  const normalized = path.resolve(stateDirectory);
  const parent = path.dirname(normalized);
  requireSecureAncestors(parent, runtime);
  try {
    fs.mkdirSync(normalized, { mode: STATE_DIRECTORY_MODE });
    fs.chownSync(normalized, runtime.rootUid, runtime.rootGid);
    fs.chmodSync(normalized, STATE_DIRECTORY_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      fail(`could not create the managed startup state directory: ${normalized}`);
    }
  }
  requireSecureDirectory(normalized, runtime, true);
  return normalized;
}

function requireSecureRegularFileStat(
  stat: fs.Stats,
  target: string,
  runtime: ManagedStartupApplicationRuntime,
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${target} must be a regular file`);
  }
  if (stat.nlink !== 1) {
    fail(`${target} must not be hardlinked`);
  }
  requireOwner(stat, target, runtime);
  if (modeOf(stat) !== STATE_FILE_MODE) {
    fail(`${target} must have mode 0600`);
  }
}

function readSecureFile(
  target: string,
  maxBytes: number,
  runtime: ManagedStartupApplicationRuntime,
): Buffer {
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    fail(`state file is missing, unreadable, or a symlink: ${target}`);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    requireSecureRegularFileStat(stat, target, runtime);
    if (stat.size < 1 || stat.size > maxBytes) {
      fail(`${target} is empty or exceeds its size limit`);
    }
    const content = fs.readFileSync(descriptor);
    if (content.length !== stat.size) {
      fail(`${target} changed while it was being read`);
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeSecureNewFile(
  target: string,
  content: string | Buffer,
  runtime: ManagedStartupApplicationRuntime,
): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      STATE_FILE_MODE,
    );
  } catch {
    fail(`refused to replace an existing state file: ${target}`);
  }
  try {
    fs.fchownSync(descriptor, runtime.rootUid, runtime.rootGid);
    fs.fchmodSync(descriptor, STATE_FILE_MODE);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(target: string): void {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function randomToken(): string {
  return randomBytes(12).toString("hex");
}

function stateControl(fingerprint: string): StateControl {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    fingerprint,
    generation: `generation-${fingerprint}`,
  };
}

function serializeStateControl(control: StateControl): string {
  return JSON.stringify({
    fingerprint: control.fingerprint,
    generation: control.generation,
    schemaVersion: control.schemaVersion,
  });
}

function parseStateControl(
  target: string,
  runtime: ManagedStartupApplicationRuntime,
): StateControl {
  const bytes = readSecureFile(target, MAX_CONTROL_FILE_BYTES, runtime);
  let raw: string;
  try {
    raw = UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${target} is not valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${target} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${target} does not contain a valid state control`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "fingerprint,generation,schemaVersion" ||
    record.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof record.fingerprint !== "string" ||
    !SHA256_RE.test(record.fingerprint) ||
    record.generation !== `generation-${record.fingerprint}`
  ) {
    fail(`${target} does not contain a valid state control`);
  }
  const control = stateControl(record.fingerprint);
  if (serializeStateControl(control) !== raw) {
    fail(`${target} is not in canonical form`);
  }
  return control;
}

function publishStateControlIfAbsent(
  stateDirectory: string,
  basename: "committed.json" | "pending.json",
  control: StateControl,
  runtime: ManagedStartupApplicationRuntime,
): {
  readonly control: StateControl;
  readonly created: boolean;
} {
  const target = path.join(stateDirectory, basename);
  const temporary = path.join(stateDirectory, `.${basename}-${randomToken()}.tmp`);
  writeSecureNewFile(temporary, serializeStateControl(control), runtime);

  try {
    fs.linkSync(temporary, target);
  } catch (error) {
    try {
      unlinkSecureControlOrTemp(temporary, runtime);
    } catch {
      // Preserve the primary publication error.
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        control: parseStateControl(target, runtime),
        created: false,
      };
    }
    fail(`could not atomically publish ${basename}`);
  }

  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail(`could not finalize atomic publication of ${basename}`);
    }
  }
  syncDirectory(stateDirectory);
  return { control, created: true };
}

function validateCorporateCaBytes(bytes: Buffer): void {
  if (bytes.length < 1 || bytes.length > MANAGED_STARTUP_CA_MAX_BYTES) {
    fail(`corporate CA bundle must contain 1-${String(MANAGED_STARTUP_CA_MAX_BYTES)} bytes`);
  }
  let pem: string;
  try {
    pem = UTF8_DECODER.decode(bytes);
  } catch {
    fail("corporate CA bundle must be valid UTF-8 PEM");
  }

  const matches = [...pem.matchAll(PEM_CERTIFICATE_RE)];
  if (
    matches.length < 1 ||
    matches.length > MANAGED_STARTUP_CA_MAX_CERTIFICATES ||
    matches[0]?.index !== 0
  ) {
    fail(
      `corporate CA bundle must contain 1-${String(
        MANAGED_STARTUP_CA_MAX_CERTIFICATES,
      )} PEM CA certificates`,
    );
  }

  let cursor = 0;
  for (const match of matches) {
    const index = match.index;
    if (index === undefined || (!/^(?:\r?\n)+$/u.test(pem.slice(cursor, index)) && index !== 0)) {
      fail("corporate CA bundle contains non-PEM material between certificates");
    }
    const block = match[0];
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      fail("corporate CA bundle contains an invalid X.509 certificate");
    }
    if (!certificate.ca) {
      fail("corporate CA bundle contains a certificate without basicConstraints CA:TRUE");
    }
    cursor = index + block.length;
  }
  if (!/^(?:\r?\n)?$/u.test(pem.slice(cursor))) {
    fail("corporate CA bundle contains trailing non-PEM material");
  }
}

export function validateManagedStartupCorporateCaTransport(
  encoded: string | undefined,
  profile: ManagedStartupProfile,
): Buffer | null {
  const expectedDigest = profile.corporateCa.bundleSha256;
  if (expectedDigest === null) {
    if (encoded !== undefined) {
      fail("corporate CA transport must be absent when the profile has no CA digest");
    }
    return null;
  }
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > Math.ceil(MANAGED_STARTUP_CA_MAX_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  ) {
    fail("corporate CA transport must be canonical standard base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    fail("corporate CA transport must be canonical standard base64");
  }
  validateCorporateCaBytes(bytes);
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    fail("corporate CA bundle does not match the profile SHA-256 digest");
  }
  return bytes;
}

function readCanonicalProfile(
  profilePath: string,
  runtime: ManagedStartupApplicationRuntime,
): {
  profile: ManagedStartupProfile;
  fingerprint: string;
} {
  const bytes = readSecureFile(profilePath, MANAGED_STARTUP_PROFILE_MAX_BYTES, runtime);
  let raw: string;
  try {
    raw = UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${profilePath} is not valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${profilePath} is not valid JSON`);
  }
  let profile: ManagedStartupProfile;
  try {
    profile = validateManagedStartupProfile(parsed);
  } catch (error) {
    fail(`${profilePath} is invalid: ${(error as Error).message}`);
  }
  if (serializeManagedStartupProfile(profile) !== raw) {
    fail(`${profilePath} is not a canonical managed startup profile`);
  }
  return {
    profile,
    fingerprint: fingerprintManagedStartupProfile(profile),
  };
}

function validateGeneration(
  stateDirectory: string,
  control: StateControl,
  runtime: ManagedStartupApplicationRuntime,
  expectedAgent?: ManagedStartupAgent,
): ValidatedGeneration {
  if (!GENERATION_RE.test(control.generation)) {
    fail("state control names an invalid generation");
  }
  const directory = path.join(stateDirectory, control.generation);
  requireSecureDirectory(directory, runtime, true);
  const entries = fs.readdirSync(directory).sort();
  if (
    entries.some((entry) => entry !== "profile.json" && entry !== "corporate-ca.pem") ||
    !entries.includes("profile.json")
  ) {
    fail(`${directory} contains missing or unsupported state files`);
  }
  const profilePath = path.join(directory, "profile.json");
  const { profile, fingerprint } = readCanonicalProfile(profilePath, runtime);
  if (fingerprint !== control.fingerprint) {
    fail(`${directory} does not match its recorded profile fingerprint`);
  }
  if (expectedAgent !== undefined && profile.agent !== expectedAgent) {
    fail(`managed startup profile targets ${profile.agent}, expected ${expectedAgent}`);
  }

  const caPath = path.join(directory, "corporate-ca.pem");
  let corporateCaPath: string | null = null;
  if (profile.corporateCa.bundleSha256 === null) {
    if (entries.includes("corporate-ca.pem")) {
      fail(`${directory} contains a CA bundle that is absent from the profile`);
    }
  } else {
    if (!entries.includes("corporate-ca.pem")) {
      fail(`${directory} is missing the CA bundle recorded by the profile`);
    }
    const caBytes = readSecureFile(caPath, MANAGED_STARTUP_CA_MAX_BYTES, runtime);
    validateCorporateCaBytes(caBytes);
    if (createHash("sha256").update(caBytes).digest("hex") !== profile.corporateCa.bundleSha256) {
      fail(`${directory} contains a CA bundle with the wrong SHA-256 digest`);
    }
    corporateCaPath = caPath;
  }

  return {
    directory,
    profilePath,
    corporateCaPath,
    profile,
    fingerprint,
  };
}

function validateDisposableDirectory(
  target: string,
  runtime: ManagedStartupApplicationRuntime,
): void {
  requireSecureDirectory(target, runtime, true);
  const entries = fs.readdirSync(target);
  if (
    entries.length > 2 ||
    entries.some((entry) => entry !== "profile.json" && entry !== "corporate-ca.pem")
  ) {
    fail(`${target} is not a recognized disposable generation`);
  }
  for (const entry of entries) {
    const file = path.join(target, entry);
    const stat = fs.lstatSync(file);
    requireSecureRegularFileStat(stat, file, runtime);
  }
}

function discardDirectory(target: string, runtime: ManagedStartupApplicationRuntime): void {
  validateDisposableDirectory(target, runtime);
  fs.rmSync(target, { recursive: true });
}

function discardDirectoryIfPresent(
  target: string,
  runtime: ManagedStartupApplicationRuntime,
): boolean {
  try {
    fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail(`could not inspect disposable generation ${target}`);
  }
  discardDirectory(target, runtime);
  return true;
}

function unlinkSecureControlOrTemp(
  target: string,
  runtime: ManagedStartupApplicationRuntime,
): void {
  const stat = fs.lstatSync(target);
  requireSecureRegularFileStat(stat, target, runtime);
  if (stat.size > MAX_CONTROL_FILE_BYTES) {
    fail(`${target} exceeds the state-control size limit`);
  }
  fs.unlinkSync(target);
}

function listStateEntries(stateDirectory: string): string[] {
  const entries = fs.readdirSync(stateDirectory).sort();
  if (entries.length > MAX_STATE_ENTRIES) {
    fail(`state directory exceeds ${String(MAX_STATE_ENTRIES)} entries`);
  }
  return entries;
}

function unlinkRecoverableControlTemp(
  stateDirectory: string,
  entry: string,
  runtime: ManagedStartupApplicationRuntime,
): void {
  const temporary = path.join(stateDirectory, entry);
  const stat = fs.lstatSync(temporary);
  if (stat.nlink === 1) {
    unlinkSecureControlOrTemp(temporary, runtime);
    return;
  }

  const basename = entry.startsWith(".committed.json-")
    ? "committed.json"
    : entry.startsWith(".pending.json-")
      ? "pending.json"
      : null;
  const target = basename === null ? null : path.join(stateDirectory, basename);
  let targetStat: fs.Stats | null = null;
  try {
    targetStat = target === null ? null : fs.lstatSync(target);
  } catch {
    fail(`refused to remove an unpaired atomic-control temporary file: ${temporary}`);
  }
  if (
    stat.nlink !== 2 ||
    targetStat === null ||
    stat.dev !== targetStat.dev ||
    stat.ino !== targetStat.ino ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    modeOf(stat) !== STATE_FILE_MODE ||
    stat.size < 1 ||
    stat.size > MAX_CONTROL_FILE_BYTES
  ) {
    fail(`refused to remove an unpaired atomic-control temporary file: ${temporary}`);
  }
  requireOwner(stat, temporary, runtime);
  requireOwner(targetStat, target as string, runtime);
  fs.unlinkSync(temporary);
}

function cleanAtomicTemps(
  stateDirectory: string,
  entries: readonly string[],
  runtime: ManagedStartupApplicationRuntime,
): void {
  let changed = false;
  for (const entry of entries) {
    const target = path.join(stateDirectory, entry);
    if (PREPARE_TEMP_RE.test(entry)) {
      discardDirectory(target, runtime);
      changed = true;
    } else if (CONTROL_TEMP_RE.test(entry)) {
      unlinkRecoverableControlTemp(stateDirectory, entry, runtime);
      changed = true;
    }
  }
  if (changed) syncDirectory(stateDirectory);
}

function requireKnownStateEntries(stateDirectory: string, entries: readonly string[]): void {
  for (const entry of entries) {
    if (
      entry === "committed.json" ||
      entry === "pending.json" ||
      GENERATION_RE.test(entry) ||
      PREPARE_TEMP_RE.test(entry) ||
      CONTROL_TEMP_RE.test(entry)
    ) {
      continue;
    }
    fail(`${stateDirectory} contains unsupported state component ${entry}`);
  }
}

function discardGenerationsExcept(
  stateDirectory: string,
  keepGeneration: string | null,
  runtime: ManagedStartupApplicationRuntime,
): void {
  for (const entry of listStateEntries(stateDirectory)) {
    if (GENERATION_RE.test(entry) && entry !== keepGeneration) {
      discardDirectoryIfPresent(path.join(stateDirectory, entry), runtime);
    }
  }
}

function optionalStateControl(
  stateDirectory: string,
  basename: "committed.json" | "pending.json",
  runtime: ManagedStartupApplicationRuntime,
): StateControl | null {
  const target = path.join(stateDirectory, basename);
  try {
    fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail(`could not inspect ${target}`);
  }
  return parseStateControl(target, runtime);
}

function removePendingControl(
  stateDirectory: string,
  runtime: ManagedStartupApplicationRuntime,
): void {
  try {
    unlinkSecureControlOrTemp(path.join(stateDirectory, "pending.json"), runtime);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  syncDirectory(stateDirectory);
}

function stateControlsMatch(left: StateControl, right: StateControl): boolean {
  return left.fingerprint === right.fingerprint && left.generation === right.generation;
}

function recoverCommittedState(
  stateDirectory: string,
  committedControl: StateControl,
  pendingControl: StateControl | null,
  requested: StateControl,
  expectedAgent: ManagedStartupAgent,
  runtime: ManagedStartupApplicationRuntime,
): ValidatedGeneration {
  const committed = validateGeneration(stateDirectory, committedControl, runtime, expectedAgent);
  if (pendingControl) removePendingControl(stateDirectory, runtime);
  discardGenerationsExcept(stateDirectory, committedControl.generation, runtime);
  syncDirectory(stateDirectory);
  if (!stateControlsMatch(committedControl, requested)) {
    fail("a different startup profile is already committed; recreate the sandbox to change it");
  }
  return committed;
}

function recoverState(
  stateDirectory: string,
  requested: StateControl,
  expectedAgent: ManagedStartupAgent,
  runtime: ManagedStartupApplicationRuntime,
): {
  committed: ValidatedGeneration | null;
  pending: ValidatedGeneration | null;
} {
  const initialEntries = listStateEntries(stateDirectory);
  requireKnownStateEntries(stateDirectory, initialEntries);
  cleanAtomicTemps(stateDirectory, initialEntries, runtime);

  const initiallyCommittedControl = optionalStateControl(stateDirectory, "committed.json", runtime);
  const pendingControl = optionalStateControl(stateDirectory, "pending.json", runtime);
  const committedAfterPendingRead = optionalStateControl(stateDirectory, "committed.json", runtime);
  const committedControl = committedAfterPendingRead ?? initiallyCommittedControl;
  if (committedControl) {
    return {
      committed: recoverCommittedState(
        stateDirectory,
        committedControl,
        pendingControl,
        requested,
        expectedAgent,
        runtime,
      ),
      pending: null,
    };
  }

  if (pendingControl) {
    if (stateControlsMatch(pendingControl, requested)) {
      const pending = validateGeneration(stateDirectory, pendingControl, runtime, expectedAgent);
      const committedAfterPendingValidation = optionalStateControl(
        stateDirectory,
        "committed.json",
        runtime,
      );
      if (committedAfterPendingValidation) {
        return {
          committed: recoverCommittedState(
            stateDirectory,
            committedAfterPendingValidation,
            pendingControl,
            requested,
            expectedAgent,
            runtime,
          ),
          pending: null,
        };
      }
      discardGenerationsExcept(stateDirectory, pendingControl.generation, runtime);
      return { committed: null, pending };
    }
    fail("a different startup profile is already pending; wait for it to commit or recreate");
  }

  return { committed: null, pending: null };
}

function createGeneration(
  stateDirectory: string,
  control: StateControl,
  profileJson: string,
  corporateCa: Buffer | null,
  runtime: ManagedStartupApplicationRuntime,
): ValidatedGeneration {
  const temporaryName = `.prepare-${String(process.pid)}-${randomToken()}`;
  const temporary = path.join(stateDirectory, temporaryName);
  const generation = path.join(stateDirectory, control.generation);
  let renameAttempted = false;
  try {
    fs.mkdirSync(temporary, { mode: STATE_DIRECTORY_MODE });
    fs.chownSync(temporary, runtime.rootUid, runtime.rootGid);
    fs.chmodSync(temporary, STATE_DIRECTORY_MODE);
    writeSecureNewFile(path.join(temporary, "profile.json"), profileJson, runtime);
    if (corporateCa) {
      writeSecureNewFile(path.join(temporary, "corporate-ca.pem"), corporateCa, runtime);
    }
    syncDirectory(temporary);
    renameAttempted = true;
    fs.renameSync(temporary, generation);
    syncDirectory(stateDirectory);
  } catch (error) {
    try {
      fs.lstatSync(temporary);
      discardDirectory(temporary, runtime);
    } catch {
      // Preserve the generation error.
    }
    if (error instanceof ManagedStartupApplicationError) throw error;
    if (
      renameAttempted &&
      ((error as NodeJS.ErrnoException).code === "EEXIST" ||
        (error as NodeJS.ErrnoException).code === "ENOTEMPTY")
    ) {
      return validateGeneration(stateDirectory, control, runtime);
    }
    fail(`could not atomically prepare generation ${control.generation}`);
  }
  return validateGeneration(stateDirectory, control, runtime);
}

function toPrepared(
  status: PreparedManagedStartupApplication["status"],
  stateDirectory: string,
  generation: ValidatedGeneration,
  expectedAgent: ManagedStartupAgent,
): PreparedManagedStartupApplication {
  return {
    status,
    stateDirectory,
    generationDirectory: generation.directory,
    profilePath: generation.profilePath,
    corporateCaPath: generation.corporateCaPath,
    fingerprint: generation.fingerprint,
    expectedAgent,
    profile: generation.profile,
  };
}

/**
 * Validate the secret-free envelope and atomically prepare immutable state.
 *
 * Agent-specific adapters may read the returned generation, make their own
 * configuration changes, and then call commitManagedStartupApplication. A
 * prepared generation is deliberately not treated as applied.
 */
export function prepareManagedStartupApplication(
  input: PrepareManagedStartupApplicationInput,
  testRuntime?: ManagedStartupApplicationTestRuntime,
): PreparedManagedStartupApplication {
  const runtime = runtimeFor(testRuntime);
  requireContainerRoot();

  let profile: ManagedStartupProfile;
  try {
    profile = decodeManagedStartupProfile(input.encodedProfile);
  } catch (error) {
    fail((error as Error).message);
  }
  if (profile.agent !== input.expectedAgent) {
    fail(`managed startup profile targets ${profile.agent}, expected ${input.expectedAgent}`);
  }
  const corporateCa = validateManagedStartupCorporateCaTransport(input.corporateCaB64, profile);
  const profileJson = serializeManagedStartupProfile(profile);
  const control = stateControl(fingerprintManagedStartupProfile(profile));
  const stateDirectory = ensureStateDirectory(input.stateDirectory, runtime);
  const recovered = recoverState(stateDirectory, control, input.expectedAgent, runtime);
  if (recovered.committed) {
    return toPrepared(
      "already-committed",
      stateDirectory,
      recovered.committed,
      input.expectedAgent,
    );
  }
  if (recovered.pending) {
    return toPrepared("prepared", stateDirectory, recovered.pending, input.expectedAgent);
  }

  const generation = createGeneration(stateDirectory, control, profileJson, corporateCa, runtime);
  const publication = publishStateControlIfAbsent(stateDirectory, "pending.json", control, runtime);
  if (
    publication.control.fingerprint !== control.fingerprint ||
    publication.control.generation !== control.generation
  ) {
    discardDirectoryIfPresent(generation.directory, runtime);
    syncDirectory(stateDirectory);
    fail("a different startup profile won the pending-state transaction");
  }
  const committedAfterPublication = optionalStateControl(stateDirectory, "committed.json", runtime);
  if (committedAfterPublication) {
    if (
      committedAfterPublication.fingerprint !== control.fingerprint ||
      committedAfterPublication.generation !== control.generation
    ) {
      if (publication.created) {
        removePendingControl(stateDirectory, runtime);
        discardDirectoryIfPresent(generation.directory, runtime);
        syncDirectory(stateDirectory);
      }
      fail("a different startup profile committed during pending-state publication");
    }
    const committedGeneration = validateGeneration(
      stateDirectory,
      committedAfterPublication,
      runtime,
      input.expectedAgent,
    );
    removePendingControl(stateDirectory, runtime);
    discardGenerationsExcept(stateDirectory, committedAfterPublication.generation, runtime);
    return toPrepared(
      "already-committed",
      stateDirectory,
      committedGeneration,
      input.expectedAgent,
    );
  }
  const activeGeneration = publication.created
    ? generation
    : validateGeneration(stateDirectory, publication.control, runtime, input.expectedAgent);
  return toPrepared("prepared", stateDirectory, activeGeneration, input.expectedAgent);
}

function validatePreparedHandle(handle: PreparedManagedStartupApplication): StateControl {
  if (
    !path.isAbsolute(handle.stateDirectory) ||
    !SHA256_RE.test(handle.fingerprint) ||
    handle.generationDirectory !==
      path.join(handle.stateDirectory, `generation-${handle.fingerprint}`) ||
    handle.profilePath !== path.join(handle.generationDirectory, "profile.json") ||
    (handle.corporateCaPath !== null &&
      handle.corporateCaPath !== path.join(handle.generationDirectory, "corporate-ca.pem"))
  ) {
    fail("prepared startup handle is malformed");
  }
  return stateControl(handle.fingerprint);
}

/**
 * Mark a prepared profile applied only after every agent-specific adapter has
 * completed. Exclusive publication of the marker is the sole commit point.
 */
export function commitManagedStartupApplication(
  prepared: PreparedManagedStartupApplication,
  testRuntime?: ManagedStartupApplicationTestRuntime,
): CommittedManagedStartupApplication {
  const runtime = runtimeFor(testRuntime);
  requireContainerRoot();
  const requested = validatePreparedHandle(prepared);
  const stateDirectory = ensureStateDirectory(prepared.stateDirectory, runtime);
  const committedControl = optionalStateControl(stateDirectory, "committed.json", runtime);
  if (committedControl) {
    if (
      committedControl.fingerprint !== requested.fingerprint ||
      committedControl.generation !== requested.generation
    ) {
      fail("a different startup profile is already committed");
    }
    const generation = validateGeneration(
      stateDirectory,
      committedControl,
      runtime,
      prepared.expectedAgent,
    );
    return {
      ...toPrepared("already-committed", stateDirectory, generation, prepared.expectedAgent),
      status: "committed",
    };
  }

  const pendingControl = optionalStateControl(stateDirectory, "pending.json", runtime);
  if (
    !pendingControl ||
    pendingControl.fingerprint !== requested.fingerprint ||
    pendingControl.generation !== requested.generation
  ) {
    fail("the prepared startup generation is not the active pending generation");
  }
  const generation = validateGeneration(
    stateDirectory,
    pendingControl,
    runtime,
    prepared.expectedAgent,
  );
  const publication = publishStateControlIfAbsent(
    stateDirectory,
    "committed.json",
    pendingControl,
    runtime,
  );
  if (
    publication.control.fingerprint !== requested.fingerprint ||
    publication.control.generation !== requested.generation
  ) {
    fail("a different startup profile won the committed-state transaction");
  }
  removePendingControl(stateDirectory, runtime);
  discardGenerationsExcept(stateDirectory, publication.control.generation, runtime);
  syncDirectory(stateDirectory);
  return {
    ...toPrepared("already-committed", stateDirectory, generation, prepared.expectedAgent),
    status: "committed",
  };
}
