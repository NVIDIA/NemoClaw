// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const NEMOCLAW_DGX_STATION_SSH_BINDING_ENV = "NEMOCLAW_DGX_STATION_SSH_BINDING";

const BINDING_SCHEMA_VERSION = 2;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const SSH_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SSH_KEY_TYPE_PATTERN = /^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._+-]+$/;
const SSH_KEY_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,3}$/;
const MAX_KNOWN_HOSTS_LINE_BYTES = 16 * 1024;
const MAX_BINDING_BYTES = 16 * 1024;
const MAX_KNOWN_HOSTS_BYTES = 64 * 1024;
const MAX_WRAPPER_BYTES = 16 * 1024;
const VERSION_DIRECTORY_PATTERN = /^v2-[a-f0-9]{32}$/;
const BINDING_KEYS = [
  "bindingFile",
  "dockerCliFile",
  "dockerShimFile",
  "dockerShimSha256",
  "hostKeyDigest",
  "knownHostsFile",
  "knownHostsSha256",
  "lookupHost",
  "peerTarget",
  "port",
  "resolvedHost",
  "schemaVersion",
  "sshUser",
  "sshWrapperDirectory",
  "sshWrapperFile",
  "sshWrapperSha256",
] as const;

export interface QualifiedStationSshIdentity {
  requestedTarget: string;
  sshTarget: string;
  resolvedHost: string;
  sshUser: string;
  port: number;
  lookupHost: string;
  hostKeyDigest: string;
  knownHostsLines: readonly string[];
}

export interface DualStationSshBinding {
  schemaVersion: 2;
  peerTarget: string;
  resolvedHost: string;
  sshUser: string;
  port: number;
  lookupHost: string;
  hostKeyDigest: string;
  bindingFile: string;
  dockerCliFile: string;
  dockerShimFile: string;
  dockerShimSha256: string;
  knownHostsFile: string;
  knownHostsSha256: string;
  sshWrapperDirectory: string;
  sshWrapperFile: string;
  sshWrapperSha256: string;
}

interface BindingHandoff {
  bindingFile: string;
  hostKeyDigest: string;
}

export interface WriteDualStationSshBindingOptions {
  /** Test seam; production resolves the effective Docker CLI from PATH. */
  dockerCliFile?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isCanonicalHost(value: string): boolean {
  return net.isIP(value) === 4 || (!/^[0-9.]+$/.test(value) && SSH_HOST_PATTERN.test(value));
}

function validatePeerTarget(value: string): string {
  requireString(value, "Station SSH peer target", 286);
  if (/[/,:;`'"\\$(){}[\]<>|&!?*\s]/.test(value)) {
    throw new Error("Station SSH peer target is invalid");
  }
  const parts = value.split("@");
  if (parts.length > 2) throw new Error("Station SSH peer target is invalid");
  const user = parts.length === 2 ? parts[0] : "";
  const host = parts.at(-1) ?? "";
  if ((user && !SSH_USERNAME_PATTERN.test(user)) || !isCanonicalHost(host)) {
    throw new Error("Station SSH peer target is invalid");
  }
  const canonical = user ? `${user}@${host}` : host;
  if (canonical !== value) throw new Error("Station SSH peer target is not canonical");
  return canonical;
}

function explicitPeerUser(peerTarget: string): string | null {
  const separator = peerTarget.indexOf("@");
  return separator === -1 ? null : peerTarget.slice(0, separator);
}

function requireAbsolutePath(value: unknown, label: string): string {
  const parsed = requireString(value, label, 4096);
  if (
    !path.isAbsolute(parsed) ||
    path.normalize(parsed) !== parsed ||
    parsed.includes(path.delimiter)
  ) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return parsed;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Station SSH binding requires a POSIX user identity");
  return uid;
}

function assertDirectory(filePath: string, mode: number, label: string): void {
  const metadata = fs.lstatSync(filePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== mode
  ) {
    throw new Error(`${label} must be an owner-only directory`);
  }
}

function readBoundedFile(filePath: string, mode: number, maxBytes: number, label: string): Buffer {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Station SSH binding requires O_NOFOLLOW support");
  }
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} must not be a symbolic link`);
    }
    throw error;
  }
  try {
    const metadata = fs.fstatSync(fd);
    if (
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o777) !== mode ||
      metadata.size <= 0 ||
      metadata.size > maxBytes
    ) {
      throw new Error(`${label} metadata is invalid`);
    }
    const content = fs.readFileSync(fd);
    if (content.length !== metadata.size || content.length > maxBytes) {
      throw new Error(`${label} changed while it was being read`);
    }
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateDockerCliFile(filePath: string): string {
  const requested = requireAbsolutePath(filePath, "Station Docker CLI");
  let canonical: string;
  try {
    canonical = fs.realpathSync(requested);
  } catch {
    throw new Error("Station Docker CLI could not be resolved");
  }
  requireAbsolutePath(canonical, "Station Docker CLI");
  const metadata = fs.lstatSync(canonical);
  const uid = currentUid();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.uid !== 0 && metadata.uid !== uid) ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0 ||
    metadata.size <= 0
  ) {
    throw new Error("Station Docker CLI is not a safe executable file");
  }
  return canonical;
}

function resolveDockerCliFile(explicit?: string): string {
  if (explicit !== undefined) return validateDockerCliFile(explicit);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory) || path.normalize(directory) !== directory) {
      continue;
    }
    const candidate = path.join(directory, "docker");
    try {
      return validateDockerCliFile(candidate);
    } catch {
      // Continue through the effective PATH until one safe Docker CLI is found.
    }
  }
  throw new Error("Station Docker CLI could not be resolved to a safe absolute executable");
}

export function stationKnownHostsDigest(raw: string): string {
  const keys = new Set<string>();
  let positiveKeys = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || /[\u0000\r\n]/.test(line)) continue;
    const fields = line.split(/\s+/);
    const marker = fields[0]?.startsWith("@") ? (fields.shift() ?? "") : "";
    if (marker !== "" && marker !== "@revoked") {
      throw new Error("Pinned Station known-hosts marker is not allowed");
    }
    if (fields.length < 3) throw new Error("Pinned Station known-hosts data is invalid");
    const [_hosts, keyType, keyData] = fields;
    if (!SSH_KEY_TYPE_PATTERN.test(keyType) || !SSH_KEY_DATA_PATTERN.test(keyData)) {
      throw new Error("Pinned Station known-hosts key is invalid");
    }
    keys.add(`${marker}|${keyType}|${keyData}`);
    if (marker === "") positiveKeys += 1;
  }
  if (keys.size === 0 || positiveKeys === 0) {
    throw new Error("Pinned Station known-hosts data has no trusted key");
  }
  return sha256([...keys].sort().join("\n"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function strictStationSshTransportArgs(): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "VerifyHostKeyDNS=no",
    "-o",
    "NoHostAuthenticationForLocalhost=no",
    "-o",
    "NumberOfPasswordPrompts=0",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=1",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ForwardX11Trusted=no",
    "-o",
    "Tunnel=no",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "KnownHostsCommand=none",
    "-o",
    "LogLevel=ERROR",
  ];
}

type PinnedStationEndpoint = Pick<
  DualStationSshBinding,
  "knownHostsFile" | "lookupHost" | "port" | "resolvedHost" | "sshUser"
>;

function pinnedOptionArgs(binding: PinnedStationEndpoint): string[] {
  return [
    ...strictStationSshTransportArgs(),
    "-o",
    `UserKnownHostsFile=${binding.knownHostsFile}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `HostKeyAlias=${binding.lookupHost}`,
    "-o",
    `Hostname=${binding.resolvedHost}`,
    "-o",
    `User=${binding.sshUser}`,
    "-o",
    `Port=${String(binding.port)}`,
  ];
}

function renderSshWrapper(binding: PinnedStationEndpoint & { knownHostsSha256: string }): string {
  const args = pinnedOptionArgs(binding).map(shellQuote).join(" ");
  return `#!/bin/bash
set -Eeuo pipefail
readonly known_hosts=${shellQuote(binding.knownHostsFile)}
readonly expected_sha256=${shellQuote(binding.knownHostsSha256)}
if [[ -x /usr/bin/sha256sum ]]; then
  actual_sha256="$(/usr/bin/sha256sum < "$known_hosts")" || exit 255
elif [[ -x /usr/bin/shasum ]]; then
  actual_sha256="$(/usr/bin/shasum -a 256 < "$known_hosts")" || exit 255
else
  printf '%s\n' 'NemoClaw could not verify the dual-Station SSH host-key pin.' >&2
  exit 255
fi
actual_sha256="${"${actual_sha256%% *}"}"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  printf '%s\n' 'NemoClaw refused a changed dual-Station SSH host-key pin.' >&2
  exit 255
fi
exec /usr/bin/ssh ${args} "$@"
`;
}

function renderDockerShim(binding: Pick<DualStationSshBinding, "dockerCliFile">): string {
  return `#!/bin/bash
set -Eeuo pipefail
exec ${shellQuote(binding.dockerCliFile)} "$@"
`;
}

function writeExclusive(filePath: string, content: string, mode: number): void {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new Error("Station SSH binding requires O_NOFOLLOW support");
  }
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(filePath, flags, mode);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

function assertRemovableTree(root: string): void {
  const metadata = fs.lstatSync(root);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("Station SSH binding directory is unsafe to remove");
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    const childMetadata = fs.lstatSync(child);
    if (childMetadata.isSymbolicLink() || childMetadata.uid !== currentUid()) {
      throw new Error("Station SSH binding tree contains an unsafe entry");
    }
    if (childMetadata.isDirectory()) assertRemovableTree(child);
    else if (!childMetadata.isFile()) {
      throw new Error("Station SSH binding tree contains a non-file entry");
    }
  }
}

export function dualStationSshBindingDirectory(resumeStatePath: string): string {
  const statePath = requireAbsolutePath(resumeStatePath, "Dual-Station resume-state path");
  return `${statePath}.ssh-binding`;
}

export function clearDualStationSshBinding(resumeStatePath: string): void {
  const runtimeDirectory = dualStationSshBindingDirectory(resumeStatePath);
  try {
    fs.lstatSync(runtimeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertRemovableTree(runtimeDirectory);
  fs.rmSync(runtimeDirectory, { recursive: true, force: false });
  fsyncDirectory(path.dirname(runtimeDirectory));
}

function ensureBindingRoot(runtimeDirectory: string, parent: string): void {
  try {
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    fs.chmodSync(runtimeDirectory, 0o700);
    fsyncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertDirectory(runtimeDirectory, 0o700, "Station SSH binding root");
}

export function writeDualStationSshBinding(
  resumeStatePath: string,
  identity: QualifiedStationSshIdentity,
  options: WriteDualStationSshBindingOptions = {},
): DualStationSshBinding {
  const runtimeDirectory = dualStationSshBindingDirectory(resumeStatePath);
  const parent = path.dirname(runtimeDirectory);
  assertDirectory(parent, 0o700, "Station SSH binding parent");
  const peerTarget = validatePeerTarget(identity.sshTarget);
  if (identity.requestedTarget !== peerTarget || !isCanonicalHost(identity.resolvedHost)) {
    throw new Error("Qualified Station SSH endpoint is invalid");
  }
  if (!SSH_USERNAME_PATTERN.test(identity.sshUser)) {
    throw new Error("Qualified Station SSH user is invalid");
  }
  const requestedUser = explicitPeerUser(peerTarget);
  if (requestedUser !== null && requestedUser !== identity.sshUser) {
    throw new Error("Qualified Station SSH target and resolved user do not match");
  }
  if (!Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65535) {
    throw new Error("Qualified Station SSH port is invalid");
  }
  const expectedLookup =
    identity.port === 22
      ? identity.resolvedHost
      : `[${identity.resolvedHost}]:${String(identity.port)}`;
  if (identity.lookupHost !== expectedLookup || !SHA256_HEX_PATTERN.test(identity.hostKeyDigest)) {
    throw new Error("Qualified Station SSH host-key identity is invalid");
  }
  if (
    !Array.isArray(identity.knownHostsLines) ||
    identity.knownHostsLines.length === 0 ||
    identity.knownHostsLines.some(
      (line) =>
        typeof line !== "string" ||
        line.length === 0 ||
        Buffer.byteLength(line, "utf8") > MAX_KNOWN_HOSTS_LINE_BYTES ||
        line !== line.trim() ||
        line.startsWith("#") ||
        /[\u0000\r\n]/.test(line),
    )
  ) {
    throw new Error("Qualified Station known-hosts evidence is invalid");
  }
  const knownHosts = `${[...new Set(identity.knownHostsLines)].sort().join("\n")}\n`;
  if (Buffer.byteLength(knownHosts, "utf8") > MAX_KNOWN_HOSTS_BYTES) {
    throw new Error("Qualified Station known-hosts evidence is too large");
  }
  if (stationKnownHostsDigest(knownHosts) !== identity.hostKeyDigest) {
    throw new Error("Qualified Station known-hosts evidence does not match its accepted digest");
  }

  const dockerCliFile = resolveDockerCliFile(options.dockerCliFile);
  ensureBindingRoot(runtimeDirectory, parent);
  const versionDirectory = path.join(runtimeDirectory, `v2-${randomBytes(16).toString("hex")}`);
  fs.mkdirSync(versionDirectory, { mode: 0o700 });
  fs.chmodSync(versionDirectory, 0o700);
  try {
    const wrapperDirectory = path.join(versionDirectory, "bin");
    fs.mkdirSync(wrapperDirectory, { mode: 0o700 });
    const finalKnownHostsFile = path.join(versionDirectory, "known_hosts");
    const finalBindingFile = path.join(versionDirectory, "binding.json");
    const finalWrapperDirectory = path.join(versionDirectory, "bin");
    const finalWrapperFile = path.join(finalWrapperDirectory, "ssh");
    const finalDockerShimFile = path.join(finalWrapperDirectory, "docker");
    const knownHostsSha256 = sha256(knownHosts);
    const persisted = {
      schemaVersion: 2,
      peerTarget,
      resolvedHost: identity.resolvedHost,
      sshUser: identity.sshUser,
      port: identity.port,
      lookupHost: identity.lookupHost,
      hostKeyDigest: identity.hostKeyDigest,
      bindingFile: finalBindingFile,
      dockerCliFile,
      dockerShimFile: finalDockerShimFile,
      knownHostsFile: finalKnownHostsFile,
      knownHostsSha256,
      sshWrapperDirectory: finalWrapperDirectory,
      sshWrapperFile: finalWrapperFile,
    } satisfies Omit<DualStationSshBinding, "dockerShimSha256" | "sshWrapperSha256">;
    const wrapper = renderSshWrapper(persisted);
    const dockerShim = renderDockerShim(persisted);
    const binding: DualStationSshBinding = {
      ...persisted,
      dockerShimSha256: sha256(dockerShim),
      sshWrapperSha256: sha256(wrapper),
    };
    writeExclusive(path.join(versionDirectory, "known_hosts"), knownHosts, 0o600);
    writeExclusive(path.join(wrapperDirectory, "ssh"), wrapper, 0o700);
    writeExclusive(path.join(wrapperDirectory, "docker"), dockerShim, 0o700);
    writeExclusive(
      path.join(versionDirectory, "binding.json"),
      `${JSON.stringify(binding)}\n`,
      0o600,
    );
    fsyncDirectory(wrapperDirectory);
    fsyncDirectory(versionDirectory);
    fsyncDirectory(runtimeDirectory);
    return loadDualStationSshBinding(binding.bindingFile, peerTarget, identity.hostKeyDigest);
  } catch (error) {
    try {
      fs.rmSync(versionDirectory, { recursive: true, force: true });
      fsyncDirectory(runtimeDirectory);
    } catch {
      // Preserve the original validation or persistence failure.
    }
    throw error;
  }
}

function parseBinding(value: unknown): DualStationSshBinding {
  if (!isRecord(value) || value.schemaVersion !== BINDING_SCHEMA_VERSION) {
    throw new Error("Station SSH binding schema is unsupported");
  }
  requireExactKeys(value, BINDING_KEYS, "Station SSH binding");
  const binding: DualStationSshBinding = {
    schemaVersion: 2,
    peerTarget: validatePeerTarget(requireString(value.peerTarget, "Station SSH peer", 286)),
    resolvedHost: requireString(value.resolvedHost, "Station SSH resolved host", 253),
    sshUser: requireString(value.sshUser, "Station SSH user", 64),
    port: requireInteger(value.port, "Station SSH port", 1, 65535),
    lookupHost: requireString(value.lookupHost, "Station SSH lookup host", 300),
    hostKeyDigest: requireString(value.hostKeyDigest, "Station SSH host-key digest", 64),
    bindingFile: requireAbsolutePath(value.bindingFile, "Station SSH binding file"),
    dockerCliFile: requireAbsolutePath(value.dockerCliFile, "Station Docker CLI"),
    dockerShimFile: requireAbsolutePath(value.dockerShimFile, "Station Docker shim"),
    dockerShimSha256: requireString(value.dockerShimSha256, "Station Docker shim SHA-256", 64),
    knownHostsFile: requireAbsolutePath(value.knownHostsFile, "Station SSH known-hosts file"),
    knownHostsSha256: requireString(value.knownHostsSha256, "Station SSH known-hosts SHA-256", 64),
    sshWrapperDirectory: requireAbsolutePath(
      value.sshWrapperDirectory,
      "Station SSH wrapper directory",
    ),
    sshWrapperFile: requireAbsolutePath(value.sshWrapperFile, "Station SSH wrapper file"),
    sshWrapperSha256: requireString(value.sshWrapperSha256, "Station SSH wrapper SHA-256", 64),
  };
  if (
    !isCanonicalHost(binding.resolvedHost) ||
    !SSH_USERNAME_PATTERN.test(binding.sshUser) ||
    (explicitPeerUser(binding.peerTarget) !== null &&
      explicitPeerUser(binding.peerTarget) !== binding.sshUser) ||
    !SHA256_HEX_PATTERN.test(binding.hostKeyDigest) ||
    !SHA256_HEX_PATTERN.test(binding.dockerShimSha256) ||
    !SHA256_HEX_PATTERN.test(binding.knownHostsSha256) ||
    !SHA256_HEX_PATTERN.test(binding.sshWrapperSha256)
  ) {
    throw new Error("Station SSH binding identity is invalid");
  }
  const expectedLookup =
    binding.port === 22
      ? binding.resolvedHost
      : `[${binding.resolvedHost}]:${String(binding.port)}`;
  if (binding.lookupHost !== expectedLookup) {
    throw new Error("Station SSH binding lookup host is invalid");
  }
  return binding;
}

function canonicalBinding(value: unknown): DualStationSshBinding {
  return parseBinding(value);
}

function validateDualStationSshBindingFiles(binding: DualStationSshBinding): DualStationSshBinding {
  const canonical = canonicalBinding(binding);
  const versionDirectory = path.dirname(canonical.bindingFile);
  const runtimeDirectory = path.dirname(versionDirectory);
  if (
    !path.basename(runtimeDirectory).endsWith(".ssh-binding") ||
    !VERSION_DIRECTORY_PATTERN.test(path.basename(versionDirectory)) ||
    canonical.bindingFile !== path.join(versionDirectory, "binding.json") ||
    canonical.knownHostsFile !== path.join(versionDirectory, "known_hosts") ||
    canonical.sshWrapperDirectory !== path.join(versionDirectory, "bin") ||
    canonical.sshWrapperFile !== path.join(versionDirectory, "bin", "ssh") ||
    canonical.dockerShimFile !== path.join(versionDirectory, "bin", "docker")
  ) {
    throw new Error("Station SSH binding paths are inconsistent");
  }
  assertDirectory(path.dirname(runtimeDirectory), 0o700, "Station SSH binding parent");
  assertDirectory(runtimeDirectory, 0o700, "Station SSH binding root");
  assertDirectory(versionDirectory, 0o700, "Station SSH binding version");
  assertDirectory(canonical.sshWrapperDirectory, 0o700, "Station SSH wrapper directory");
  if (validateDockerCliFile(canonical.dockerCliFile) !== canonical.dockerCliFile) {
    throw new Error("Station Docker CLI changed after qualification");
  }
  const dockerShim = readBoundedFile(
    canonical.dockerShimFile,
    0o700,
    MAX_WRAPPER_BYTES,
    "Station Docker shim",
  );
  if (
    sha256(dockerShim) !== canonical.dockerShimSha256 ||
    dockerShim.toString("utf8") !== renderDockerShim(canonical)
  ) {
    throw new Error("Station Docker shim changed after qualification");
  }
  const knownHosts = readBoundedFile(
    canonical.knownHostsFile,
    0o600,
    MAX_KNOWN_HOSTS_BYTES,
    "Station SSH known-hosts file",
  );
  if (
    sha256(knownHosts) !== canonical.knownHostsSha256 ||
    stationKnownHostsDigest(knownHosts.toString("utf8")) !== canonical.hostKeyDigest
  ) {
    throw new Error("Station SSH known-hosts binding changed after qualification");
  }
  const wrapper = readBoundedFile(
    canonical.sshWrapperFile,
    0o700,
    MAX_WRAPPER_BYTES,
    "Station SSH wrapper",
  );
  if (
    sha256(wrapper) !== canonical.sshWrapperSha256 ||
    wrapper.toString("utf8") !== renderSshWrapper(canonical)
  ) {
    throw new Error("Station SSH wrapper changed after qualification");
  }
  return canonical;
}

export function assertDualStationSshBindingFiles(binding: DualStationSshBinding): void {
  validateDualStationSshBindingFiles(binding);
}

export function loadDualStationSshBinding(
  bindingFile: string,
  expectedPeerTarget: string,
  expectedHostKeyDigest: string,
): DualStationSshBinding {
  const expectedPeer = validatePeerTarget(expectedPeerTarget);
  if (!SHA256_HEX_PATTERN.test(expectedHostKeyDigest)) {
    throw new Error("Expected Station SSH host-key digest is invalid");
  }
  const normalizedBindingFile = requireAbsolutePath(bindingFile, "Station SSH binding file");
  const raw = readBoundedFile(
    normalizedBindingFile,
    0o600,
    MAX_BINDING_BYTES,
    "Station SSH binding file",
  );
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Station SSH binding file contains invalid JSON");
  }
  const binding = parseBinding(value);
  if (
    binding.bindingFile !== normalizedBindingFile ||
    binding.peerTarget !== expectedPeer ||
    binding.hostKeyDigest !== expectedHostKeyDigest
  ) {
    throw new Error("Station SSH binding does not match the qualified peer identity");
  }
  return validateDualStationSshBindingFiles(binding);
}

export function encodeDualStationSshBindingHandoff(binding: DualStationSshBinding): string {
  const canonical = validateDualStationSshBindingFiles(binding);
  const handoff: BindingHandoff = {
    bindingFile: canonical.bindingFile,
    hostKeyDigest: canonical.hostKeyDigest,
  };
  return Buffer.from(JSON.stringify(handoff), "utf8").toString("base64url");
}

/**
 * Promote an installer-qualified binding into a separate owner-only lifecycle
 * tree before the temporary installer resume state is retired.
 */
export function copyDualStationSshBinding(
  statePath: string,
  binding: DualStationSshBinding,
): DualStationSshBinding {
  const canonical = validateDualStationSshBindingFiles(binding);
  const knownHosts = readBoundedFile(
    canonical.knownHostsFile,
    0o600,
    MAX_KNOWN_HOSTS_BYTES,
    "Station SSH known-hosts file",
  )
    .toString("utf8")
    .trimEnd()
    .split("\n");
  return writeDualStationSshBinding(
    statePath,
    {
      requestedTarget: canonical.peerTarget,
      sshTarget: canonical.peerTarget,
      resolvedHost: canonical.resolvedHost,
      sshUser: canonical.sshUser,
      port: canonical.port,
      lookupHost: canonical.lookupHost,
      hostKeyDigest: canonical.hostKeyDigest,
      knownHostsLines: knownHosts,
    },
    { dockerCliFile: canonical.dockerCliFile },
  );
}

export function loadDualStationSshBindingHandoff(
  token: string,
  expectedPeerTarget: string,
): DualStationSshBinding {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 8192 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new Error(`${NEMOCLAW_DGX_STATION_SSH_BINDING_ENV} is invalid`);
  }
  let value: unknown;
  try {
    const decoded = Buffer.from(token, "base64url");
    if (decoded.toString("base64url") !== token) throw new Error("non-canonical base64url");
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error(`${NEMOCLAW_DGX_STATION_SSH_BINDING_ENV} is invalid`);
  }
  if (!isRecord(value)) {
    throw new Error(`${NEMOCLAW_DGX_STATION_SSH_BINDING_ENV} is invalid`);
  }
  requireExactKeys(value, ["bindingFile", "hostKeyDigest"], NEMOCLAW_DGX_STATION_SSH_BINDING_ENV);
  const bindingFile = requireAbsolutePath(value.bindingFile, "Station SSH binding handoff file");
  const hostKeyDigest = requireString(
    value.hostKeyDigest,
    "Station SSH binding handoff digest",
    64,
  );
  return loadDualStationSshBinding(bindingFile, expectedPeerTarget, hostKeyDigest);
}

export function dualStationPinnedSshArgs(binding: DualStationSshBinding): string[] {
  return pinnedOptionArgs(validateDualStationSshBindingFiles(binding));
}

export function dualStationDockerSshUri(binding: DualStationSshBinding): string {
  const canonical = validateDualStationSshBindingFiles(binding);
  const port = canonical.port === 22 ? "" : `:${String(canonical.port)}`;
  return `ssh://${canonical.sshUser}@${canonical.resolvedHost}${port}`;
}
