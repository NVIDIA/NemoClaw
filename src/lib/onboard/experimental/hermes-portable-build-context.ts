// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  renderHermesPortableDockerfileBuildSettings,
  type HermesPortableDockerfileBuildSettings,
} from "../dockerfile-patch";
import { HERMES_PORTABLE_BUILD_CONTEXT_FILES } from "./hermes-portable-build-context-files";

const CONTEXT_SCHEMA_VERSION = 1 as const;
const MAX_CONTEXT_ENTRIES = 1024;
const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 512;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
const TRANSACTION = /^[a-f0-9-]{36}$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const OPEN_READ_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0) |
  (typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0);
const SOURCE_DOCKERFILE_RELATIVE_PATH = "agents/hermes/Dockerfile" as const;
const CONTEXT_DOCKERFILE_RELATIVE_PATH = "Dockerfile" as const;

const LOCAL_COPY_SOURCES = [
  "agents/hermes/build-mcp-digest.py",
  "agents/hermes/config/",
  "agents/hermes/cron-restore-control.py",
  "agents/hermes/finalize-tirith-marker.py",
  "agents/hermes/generate-config.ts",
  "agents/hermes/hermes-cli-adapter-v1.json",
  "agents/hermes/hermes-wrapper.py",
  "agents/hermes/host/managed-tool-gateway-matrix.json",
  "agents/hermes/image-build-probes.py",
  "agents/hermes/managed_policy.py",
  "agents/hermes/mcp-config-transaction.py",
  "agents/hermes/patch-cron-execution-runtime.py",
  "agents/hermes/patch-cron-restore-drain.py",
  "agents/hermes/patch-discord-recovery-permissions.py",
  "agents/hermes/patch-gateway-process-identity.py",
  "agents/hermes/patch-gateway-runtime-metadata.py",
  "agents/hermes/patch-hermes-sqlite-temp-store.py",
  "agents/hermes/patch-langfuse-credentials.mts",
  "agents/hermes/patch-neutral-platform-env-activation.py",
  "agents/hermes/patch-profile-policy-defaults.py",
  "agents/hermes/patch-session-list-preview.py",
  "agents/hermes/plugin/",
  "agents/hermes/runtime-config-guard.py",
  "agents/hermes/runtime-state-mutation-publisher-v1.json",
  "agents/hermes/security-dependencies.patch",
  "agents/hermes/seed-dashboard-config.py",
  "agents/hermes/start.sh",
  "agents/hermes/state-lock-plan.json",
  "agents/hermes/validate-cli-adapter.py",
  "agents/hermes/validate-env-secret-boundary.py",
  "nemoclaw-blueprint/",
  "nemoclaw-blueprint/scripts/*.js",
  "scripts/gateway-control.sh",
  "scripts/lib/bundled-npm-package.mts",
  "scripts/lib/corporate-ca-runtime.sh",
  "scripts/lib/entrypoint-env-wrapper.sh",
  "scripts/lib/gateway-supervisor.sh",
  "scripts/lib/openclaw-npm-remediation.mts",
  "scripts/lib/patch-bundled-npm-ip-address.mts",
  "scripts/lib/reviewed-npm-archive.mts",
  "scripts/lib/sandbox-init.sh",
  "scripts/lib/sandbox-rlimits.sh",
  "scripts/managed-bootstrap-entrypoint.c",
  "scripts/managed-bootstrap-trampoline.sh",
  "scripts/managed-gateway-control.py",
  "scripts/managed-startup-hold.sh",
  "scripts/patch-bundled-npm-brace-expansion.mts",
  "scripts/patch-bundled-npm-tar.mts",
  "scripts/runtime-state-mutation-control.py",
  "scripts/runtime-state-mutation-startup-gate.py",
  "scripts/runtime_state_mutation_hermes_publisher.py",
  "scripts/state-dir-guard.py",
  "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json",
  "src/lib/hermes-managed-route.ts",
  "src/lib/messaging/",
  "src/lib/messaging/channels/googlechat/runtime/hermes-adapter.py",
  "src/lib/tool-disclosure.ts",
  "tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-7.5.21.tgz",
  "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle",
  "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/BUNDLED_PACKAGES.json",
  "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/THIRD_PARTY_LICENSES.txt",
  "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle",
] as const;

type SourceEntry = {
  readonly kind: "directory" | "file";
  readonly relativePath: string;
  readonly mode: number;
  readonly device: string;
  readonly inode: string;
  readonly modifiedTimeNanoseconds: string;
  readonly changedTimeNanoseconds: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly bytes?: Buffer;
};

type RevisionEvidence = {
  readonly revision: string;
  readonly files: readonly {
    readonly pathSha256: string;
    readonly bytesSha256: string;
    readonly device: string;
    readonly inode: string;
    readonly size: string;
    readonly modifiedTimeNanoseconds: string;
    readonly changedTimeNanoseconds: string;
  }[];
};

type DirectoryEvidence = {
  readonly pathSha256: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly ownerUid: string;
};

export interface HermesPortableBuildContextAuthority {
  readonly schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly sourceRevision: string;
  readonly dockerfileRelativePath: typeof CONTEXT_DOCKERFILE_RELATIVE_PATH;
  readonly sourceManifestSha256: string;
  readonly contextManifestSha256: string;
}

export type HermesPortableBuildContextSettings = HermesPortableDockerfileBuildSettings;

export interface HermesPortableBuildContextPlan {
  readonly authority: HermesPortableBuildContextAuthority;
  readonly sourceDockerfilePath: string;
  assertCurrentSource(): void;
  materialize(input: {
    readonly sandboxName: string;
    readonly transactionId: string;
    readonly createIntentSha256: string;
    readonly stateDir: string;
  }): HermesPortableStagedBuildContext;
  retire(input: {
    readonly sandboxName: string;
    readonly transactionId: string;
    readonly createIntentSha256: string;
    readonly stateDir: string;
  }): boolean;
}

export interface HermesPortableStagedBuildContext {
  readonly buildContextPath: string;
  readonly dockerfilePath: string;
  assertCurrent(): void;
}

type StagedEntry = Omit<
  SourceEntry,
  "bytes" | "modifiedTimeNanoseconds" | "changedTimeNanoseconds"
>;

type StagedAuthority = {
  readonly schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly createIntentSha256: string;
  readonly contextManifestSha256: string;
  readonly contextPath: string;
  readonly entries: readonly StagedEntry[];
};

function fail(message: string): never {
  throw new Error(`Hermes portable build context ${message}`);
}

function currentUid(): bigint {
  const uid = process.getuid?.();
  if (uid === undefined) fail("requires current-user filesystem authority");
  return BigInt(uid);
}

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value: unknown): string {
  return digest(JSON.stringify(value));
}

function requireSafeRelativePath(relativePath: string): void {
  if (
    !relativePath ||
    Buffer.byteLength(relativePath) > MAX_RELATIVE_PATH_BYTES ||
    CONTROL.test(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..")
  ) {
    fail("contains an invalid source path");
  }
  const parts = relativePath.split("/");
  const basename = parts.at(-1)!;
  if (
    parts.some((part) =>
      [".git", ".hg", ".svn", "node_modules", "dist", "coverage"].includes(part),
    ) ||
    parts.some((part) => part === ".env" || part.startsWith(".env.")) ||
    parts.some((part) => [".direnv", ".ssh", "secrets"].includes(part)) ||
    [".envrc", ".npmrc", ".netrc", ".pypirc", ".credentials"].includes(basename) ||
    [".key", ".pem", ".pfx", ".p12", ".jks", ".keystore", ".tfvars"].some((suffix) =>
      basename.endsWith(suffix),
    ) ||
    ["_ecdsa", "_ed25519", "_rsa"].some((suffix) => basename.endsWith(suffix)) ||
    ["credentials.json", "key.json", "secrets.json", "secrets.yaml", "token.json"].includes(
      basename,
    ) ||
    /^service-account.*\.json$/u.test(basename)
  ) {
    fail("contains a prohibited generated or environment path");
  }
}

function isIgnoredCachePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.includes("__pycache__") || parts.includes(".cache") || relativePath.endsWith(".pyc");
}

function sourceTokenMatches(relativePath: string, token: string): boolean {
  if (token.endsWith("/")) return relativePath.startsWith(token);
  if (token === "nemoclaw-blueprint/scripts/*.js") {
    return /^nemoclaw-blueprint\/scripts\/[^/]+\.js$/u.test(relativePath);
  }
  return relativePath === token;
}

function parseDockerfileSources(bytes: Buffer): readonly string[] {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    fail("Dockerfile is not strict UTF-8");
  }
  const local: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!/^(?:COPY|ADD)\s/iu.test(line)) continue;
    if (!/^(?:COPY|ADD)\s/u.test(line)) {
      fail("Dockerfile uses a noncanonical COPY or ADD opcode");
    }
    if (line.endsWith("\\") || line.includes("[")) {
      fail("Dockerfile uses an unsupported COPY or ADD grammar");
    }
    const tokens = line.split(/\s+/u);
    const command = tokens.shift();
    const options: string[] = [];
    while (tokens[0]?.startsWith("--")) options.push(tokens.shift()!);
    if (tokens.length < 2) fail("Dockerfile has an incomplete COPY or ADD instruction");
    const sources = tokens.slice(0, -1);
    if (command === "ADD") {
      if (
        sources.length !== 1 ||
        !sources[0]!.startsWith("https://files.pythonhosted.org/") ||
        options.length !== 1 ||
        !/^--checksum=sha256:[a-f0-9]{64}$/u.test(options[0]!)
      ) {
        fail("Dockerfile has an unsupported local or unpinned ADD instruction");
      }
      continue;
    }
    const from = options.find((option) => option.startsWith("--from="));
    if (from) {
      if (options.length !== 1 || !/^--from=[a-z0-9][a-z0-9-]*$/u.test(from)) {
        fail("Dockerfile has an unsupported cross-stage COPY instruction");
      }
      continue;
    }
    if (options.length > 0) fail("Dockerfile has a non-Portable local COPY option");
    local.push(...sources);
  }
  const expected = [...LOCAL_COPY_SOURCES].sort();
  const actual = [...local].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("Dockerfile local COPY sources disagree with the reviewed allowlist");
  }
  return local;
}

function readRevisionFile(filePath: string): {
  readonly bytes: Buffer;
  readonly evidence: RevisionEvidence["files"][number];
} {
  const named = fs.lstatSync(filePath, { bigint: true });
  const descriptor = fs.openSync(filePath, OPEN_READ_FLAGS);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      before.uid !== currentUid() ||
      before.nlink !== 1n ||
      (before.mode & 0o22n) !== 0n ||
      before.size < 1n ||
      before.size > 4096n ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      fail("source revision evidence is unsafe");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      fail("source revision evidence changed while reading");
    }
    return {
      bytes,
      evidence: {
        pathSha256: digest(path.resolve(filePath)),
        bytesSha256: digest(bytes),
        device: String(before.dev),
        inode: String(before.ino),
        size: String(before.size),
        modifiedTimeNanoseconds: String(before.mtimeNs),
        changedTimeNanoseconds: String(before.ctimeNs),
      },
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function strictText(bytes: Buffer, label: string): string {
  try {
    return UTF8.decode(bytes).trim();
  } catch {
    fail(`${label} is not strict UTF-8`);
  }
}

function requireGitDirectory(directory: string): void {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o22n) !== 0n ||
    fs.realpathSync(directory) !== directory
  ) {
    fail("Git directory authority is unsafe");
  }
}

function readPackedRevision(
  commonDirectory: string,
  reference: string,
): { readonly revision: string; readonly evidence: RevisionEvidence["files"][number] } {
  const packed = readRevisionFile(path.join(commonDirectory, "packed-refs"));
  const text = strictText(packed.bytes, "Git packed references");
  let revision: string | null = null;
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const match = /^([a-f0-9]{40,64}) (refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/u.exec(line);
    if (!match) fail("Git packed references are invalid");
    if (match[2] === reference) {
      if (revision) fail("Git packed reference is ambiguous");
      revision = match[1]!;
    }
  }
  if (!revision) fail("Git revision is unavailable");
  return { revision, evidence: packed.evidence };
}

function captureGitRevision(
  gitDirectory: string,
  initialEvidence: readonly RevisionEvidence["files"][number][],
): RevisionEvidence {
  requireGitDirectory(gitDirectory);
  const head = readRevisionFile(path.join(gitDirectory, "HEAD"));
  const headText = strictText(head.bytes, "Git HEAD");
  if (REVISION.test(headText)) {
    return { revision: headText, files: [...initialEvidence, head.evidence] };
  }
  const ref = /^ref: (refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+)$/u.exec(headText)?.[1];
  if (!ref || ref.includes("..")) fail("Git HEAD reference is invalid");
  const commonDirectoryFile = path.join(gitDirectory, "commondir");
  const commonDirectoryRead = fs.existsSync(commonDirectoryFile)
    ? readRevisionFile(commonDirectoryFile)
    : null;
  const commonDirectory = commonDirectoryRead
    ? path.resolve(gitDirectory, strictText(commonDirectoryRead.bytes, "Git common directory"))
    : gitDirectory;
  requireGitDirectory(commonDirectory);
  const loosePath = path.join(commonDirectory, ref);
  if (fs.existsSync(loosePath)) {
    const loose = readRevisionFile(loosePath);
    const revision = strictText(loose.bytes, "Git revision");
    if (!REVISION.test(revision)) fail("Git revision is invalid");
    return {
      revision,
      files: [
        ...initialEvidence,
        head.evidence,
        ...(commonDirectoryRead ? [commonDirectoryRead.evidence] : []),
        loose.evidence,
      ],
    };
  }
  const packed = readPackedRevision(commonDirectory, ref);
  return {
    revision: packed.revision,
    files: [
      ...initialEvidence,
      head.evidence,
      ...(commonDirectoryRead ? [commonDirectoryRead.evidence] : []),
      packed.evidence,
    ],
  };
}

function captureSourceRevision(rootPath: string): RevisionEvidence {
  const stamped = path.join(rootPath, ".source-revision");
  if (fs.existsSync(stamped)) {
    const read = readRevisionFile(stamped);
    const revision = strictText(read.bytes, "source revision");
    if (!REVISION.test(revision)) fail("source revision is invalid");
    return { revision, files: [read.evidence] };
  }
  const gitPointerPath = path.join(rootPath, ".git");
  const gitPointerStat = fs.lstatSync(gitPointerPath, { bigint: true });
  if (gitPointerStat.isDirectory() && !gitPointerStat.isSymbolicLink()) {
    return captureGitRevision(gitPointerPath, []);
  }
  const pointer = readRevisionFile(gitPointerPath);
  const pointerText = strictText(pointer.bytes, "Git directory pointer");
  const match = /^gitdir: (.+)$/u.exec(pointerText);
  if (!match) fail("Git directory pointer is invalid");
  const gitDirectory = path.resolve(rootPath, match[1]!);
  return captureGitRevision(gitDirectory, [pointer.evidence]);
}

function stableDirectoryMembers(absolutePath: string, relativePath: string): readonly string[] {
  const before = fs.lstatSync(absolutePath, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== currentUid() ||
    (before.mode & 0o22n) !== 0n
  ) {
    fail("source directory authority is unsafe");
  }
  const members = fs.readdirSync(absolutePath).sort();
  const after = fs.lstatSync(absolutePath, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    fail(`source directory changed while reading: ${relativePath}`);
  }
  return members;
}

function captureDirectoryChain(directory: string): readonly DirectoryEvidence[] {
  const uid = currentUid();
  const chain: DirectoryEvidence[] = [];
  let current = directory;
  for (;;) {
    const named = fs.lstatSync(current, { bigint: true });
    if (
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      (named.uid !== 0n && named.uid !== uid) ||
      (named.mode & 0o22n) !== 0n ||
      fs.realpathSync(current) !== current
    ) {
      fail("source root directory chain is unsafe");
    }
    chain.push({
      pathSha256: digest(current),
      device: String(named.dev),
      inode: String(named.ino),
      mode: String(named.mode),
      ownerUid: String(named.uid),
    });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function sourceFileModeMatchesGitMode(mode: bigint, expectedMode: "100644" | "100755"): boolean {
  const actualMode = Number(mode & 0o777n);
  const checkoutMode = expectedMode === "100755" ? 0o755 : 0o644;
  const privateCheckoutMode = expectedMode === "100755" ? 0o700 : 0o600;
  return (
    (actualMode & 0o22) === 0 && (actualMode === checkoutMode || actualMode === privateCheckoutMode)
  );
}

function readSourceFile(
  rootPath: string,
  relativePath: string,
  expectedMode: "100644" | "100755",
): SourceEntry {
  const absolutePath = path.join(rootPath, relativePath);
  const named = fs.lstatSync(absolutePath, { bigint: true });
  const descriptor = fs.openSync(absolutePath, OPEN_READ_FLAGS);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      before.uid !== currentUid() ||
      before.nlink !== 1n ||
      !sourceFileModeMatchesGitMode(before.mode, expectedMode) ||
      before.size < 1n ||
      before.size > BigInt(MAX_CONTEXT_FILE_BYTES)
    ) {
      fail(`source file authority is unsafe: ${relativePath}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalNamed = fs.lstatSync(absolutePath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      finalNamed.dev !== after.dev ||
      finalNamed.ino !== after.ino ||
      BigInt(bytes.byteLength) !== after.size
    ) {
      fail(`source file disagrees with the accepted revision: ${relativePath}`);
    }
    return {
      kind: "file",
      relativePath,
      mode: Number(before.mode & 0o777n),
      device: String(before.dev),
      inode: String(before.ino),
      modifiedTimeNanoseconds: String(before.mtimeNs),
      changedTimeNanoseconds: String(before.ctimeNs),
      size: bytes.byteLength,
      sha256: digest(bytes),
      bytes,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function captureSourceEntries(
  rootPath: string,
  tracked: ReadonlyMap<string, "100644" | "100755" | "160000">,
): readonly SourceEntry[] {
  const selected = new Set(tracked.keys());
  const entries: SourceEntry[] = [];
  let totalBytes = 0;
  const addStructuralParents = (relativePath: string): void => {
    const parts = relativePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (entries.some((entry) => entry.relativePath === current)) continue;
      const absolutePath = path.join(rootPath, current);
      stableDirectoryMembers(absolutePath, current);
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      entries.push({
        kind: "directory",
        relativePath: current,
        mode: Number(stat.mode & 0o777n),
        device: String(stat.dev),
        inode: String(stat.ino),
        modifiedTimeNanoseconds: String(stat.mtimeNs),
        changedTimeNanoseconds: String(stat.ctimeNs),
      });
    }
  };
  const visit = (relativePath: string): void => {
    if (isIgnoredCachePath(relativePath)) return;
    requireSafeRelativePath(relativePath);
    addStructuralParents(relativePath);
    const absolutePath = path.join(rootPath, relativePath);
    const stat = fs.lstatSync(absolutePath, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      fail(`source contains a symlink or special entry: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      const members = stableDirectoryMembers(absolutePath, relativePath);
      entries.push({
        kind: "directory",
        relativePath,
        mode: Number(stat.mode & 0o777n),
        device: String(stat.dev),
        inode: String(stat.ino),
        modifiedTimeNanoseconds: String(stat.mtimeNs),
        changedTimeNanoseconds: String(stat.ctimeNs),
      });
      for (const member of members) {
        const child = `${relativePath}/${member}`;
        if (isIgnoredCachePath(child)) continue;
        const trackedHere = selected.has(child);
        const trackedBelow = [...selected].some((entry) => entry.startsWith(`${child}/`));
        if (!trackedHere && !trackedBelow)
          fail(`source directory contains an unreviewed entry: ${child}`);
        visit(child);
      }
      return;
    }
    const expectedMode = tracked.get(relativePath);
    if (!expectedMode || expectedMode === "160000") {
      fail(`source file is not part of the accepted revision: ${relativePath}`);
    }
    const entry = readSourceFile(rootPath, relativePath, expectedMode);
    totalBytes += entry.size!;
    if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) fail("exceeds the bounded total byte limit");
    entries.push(entry);
  };

  visit(SOURCE_DOCKERFILE_RELATIVE_PATH);
  for (const token of LOCAL_COPY_SOURCES) {
    if (token.endsWith("/")) {
      visit(token.slice(0, -1));
    } else if (token === "nemoclaw-blueprint/scripts/*.js") {
      for (const relativePath of [...selected]
        .filter((entry) => sourceTokenMatches(entry, token))
        .sort()) {
        if (!entries.some((entry) => entry.relativePath === relativePath)) visit(relativePath);
      }
    } else if (!entries.some((entry) => entry.relativePath === token)) {
      visit(token);
    }
  }
  const unique = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const ordered = [...unique.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  if (ordered.length > MAX_CONTEXT_ENTRIES) fail("exceeds the bounded entry limit");
  return ordered;
}

function sourceAuthority(
  sourceEntries: readonly SourceEntry[],
  contextEntries: readonly SourceEntry[],
  revision: RevisionEvidence,
  sourceDirectoryChain: readonly DirectoryEvidence[],
): HermesPortableBuildContextAuthority {
  const serializable = sourceEntries.map(({ bytes: _bytes, ...entry }) => entry);
  const sourceManifestSha256 = canonicalDigest({
    revision,
    sourceDirectoryChain,
    entries: serializable,
  });
  const contextManifestSha256 = canonicalDigest({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    dockerfileRelativePath: CONTEXT_DOCKERFILE_RELATIVE_PATH,
    entries: contextEntries.map((entry) => ({
      kind: entry.kind,
      relativePath: entry.relativePath,
      mode: entry.mode,
      ...(entry.kind === "file" ? { size: entry.size, sha256: entry.sha256 } : {}),
    })),
  });
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    sourceRevision: revision.revision,
    dockerfileRelativePath: CONTEXT_DOCKERFILE_RELATIVE_PATH,
    sourceManifestSha256,
    contextManifestSha256,
  };
}

function renderContextEntries(
  sourceEntries: readonly SourceEntry[],
  settings: HermesPortableBuildContextSettings,
): readonly SourceEntry[] {
  return sourceEntries.map((entry) => {
    if (entry.kind !== "file" || entry.relativePath !== SOURCE_DOCKERFILE_RELATIVE_PATH) {
      return entry;
    }
    const bytes = Buffer.from(
      renderHermesPortableDockerfileBuildSettings(UTF8.decode(entry.bytes!), settings),
      "utf8",
    );
    return {
      ...entry,
      relativePath: CONTEXT_DOCKERFILE_RELATIVE_PATH,
      bytes,
      size: bytes.byteLength,
      sha256: digest(bytes),
    };
  });
}

function capture(
  rootPath: string,
  settings: HermesPortableBuildContextSettings,
): {
  readonly authority: HermesPortableBuildContextAuthority;
  readonly sourceEntries: readonly SourceEntry[];
  readonly contextEntries: readonly SourceEntry[];
} {
  if (!path.isAbsolute(rootPath) || fs.realpathSync(rootPath) !== rootPath)
    fail("source root is invalid");
  const revision = captureSourceRevision(rootPath);
  const sourceDirectoryChain = captureDirectoryChain(rootPath);
  const tracked = new Map(
    HERMES_PORTABLE_BUILD_CONTEXT_FILES.map((entry) => [entry.path, entry.mode] as const),
  );
  const sourceEntries = captureSourceEntries(rootPath, tracked);
  const dockerfile = sourceEntries.find(
    (entry) => entry.relativePath === SOURCE_DOCKERFILE_RELATIVE_PATH,
  );
  if (dockerfile?.kind !== "file" || !dockerfile.bytes) fail("Dockerfile source is unavailable");
  parseDockerfileSources(dockerfile.bytes);
  const contextEntries = renderContextEntries(sourceEntries, settings);
  return {
    authority: sourceAuthority(sourceEntries, contextEntries, revision, sourceDirectoryChain),
    sourceEntries,
    contextEntries,
  };
}

function contextPaths(
  stateDir: string,
  sandboxName: string,
  transactionId: string,
  intent: string,
) {
  if (!TRANSACTION.test(transactionId) || !SHA256.test(intent))
    fail("transaction identity is invalid");
  const sandbox = digest(sandboxName);
  const root = path.join(stateDir, "hermes-portable-build-context");
  const directory = path.join(root, sandbox);
  const suffix = `${transactionId}.${intent}`;
  return {
    root,
    directory,
    context: path.join(directory, `context.${suffix}`),
    retiring: path.join(directory, `retiring.${suffix}`),
    authority: path.join(directory, `authority.${suffix}.json`),
    authorityNext: path.join(directory, `.authority.${suffix}.next`),
    retired: path.join(directory, `retired.${suffix}.json`),
  };
}

function ensurePrivateDirectory(directory: string, create: boolean): fs.BigIntStats {
  create && fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o777n) !== 0o700n
  ) {
    fail("transaction directory authority is unsafe");
  }
  return stat;
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function prepareTransactionDirectory(paths: ReturnType<typeof contextPaths>): void {
  const stateDirectory = path.dirname(paths.root);
  const state = fs.lstatSync(stateDirectory, { bigint: true });
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== currentUid() ||
    (state.mode & 0o22n) !== 0n
  ) {
    fail("state directory authority is unsafe");
  }
  if (!fs.existsSync(paths.root)) ensurePrivateDirectory(paths.root, true);
  else ensurePrivateDirectory(paths.root, false);
  if (!fs.existsSync(paths.directory)) {
    ensurePrivateDirectory(paths.directory, true);
    fsyncDirectory(paths.root);
  } else {
    ensurePrivateDirectory(paths.directory, false);
  }
  if (fs.readdirSync(paths.directory).length > 6)
    fail("transaction directory has ambiguous entries");
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written < 1) fail("staged file write made no progress");
    offset += written;
  }
}

function stageEntries(
  contextPath: string,
  entries: readonly SourceEntry[],
): StagedAuthority["entries"] {
  fs.mkdirSync(contextPath, { mode: 0o700 });
  const staged: StagedEntry[] = [];
  for (const entry of entries) {
    const target = path.join(contextPath, entry.relativePath);
    if (entry.kind === "directory") {
      fs.mkdirSync(target, { recursive: false, mode: entry.mode });
      fs.chmodSync(target, entry.mode);
    } else {
      const parent = path.dirname(target);
      if (!fs.existsSync(parent)) fail("staged file parent is absent");
      const descriptor = fs.openSync(
        target,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        entry.mode,
      );
      try {
        fs.fchmodSync(descriptor, entry.mode);
        writeAll(descriptor, entry.bytes!);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    const stat = fs.lstatSync(target, { bigint: true });
    staged.push({
      kind: entry.kind,
      relativePath: entry.relativePath,
      mode: Number(stat.mode & 0o777n),
      device: String(stat.dev),
      inode: String(stat.ino),
      ...(entry.kind === "file" ? { size: entry.size, sha256: entry.sha256 } : {}),
    });
  }
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "directory") fsyncDirectory(path.join(contextPath, entry.relativePath));
  }
  fsyncDirectory(contextPath);
  return staged;
}

function readPrivateFile(filePath: string, allowedLinks = 1n): Buffer {
  const named = fs.lstatSync(filePath, { bigint: true });
  const descriptor = fs.openSync(filePath, OPEN_READ_FLAGS);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      named.isSymbolicLink() ||
      before.uid !== currentUid() ||
      (before.mode & 0o777n) !== 0o600n ||
      before.nlink !== allowedLinks ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      before.size > 1024n * 1024n
    ) {
      fail("transaction evidence file is unsafe");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      fail("transaction evidence changed while reading");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishPrivateEvidence(
  canonicalPath: string,
  nextPath: string,
  bytes: Buffer,
  parent: string,
): void {
  if (!fs.existsSync(canonicalPath)) {
    if (!fs.existsSync(nextPath)) {
      const descriptor = fs.openSync(
        nextPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.fchmodSync(descriptor, 0o600);
        writeAll(descriptor, bytes);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    if (!readPrivateFile(nextPath).equals(bytes)) fail("staged transaction evidence disagrees");
    fs.linkSync(nextPath, canonicalPath);
    fsyncDirectory(parent);
  }
  const nextExists = fs.existsSync(nextPath);
  const canonical = readPrivateFile(canonicalPath, nextExists ? 2n : 1n);
  if (!canonical.equals(bytes)) fail("published transaction evidence disagrees");
  if (nextExists) {
    const left = fs.lstatSync(nextPath, { bigint: true });
    const right = fs.lstatSync(canonicalPath, { bigint: true });
    if (left.dev !== right.dev || left.ino !== right.ino) fail("transaction evidence is ambiguous");
    fs.unlinkSync(nextPath);
    fsyncDirectory(parent);
  }
}

function serializeStagedAuthority(authority: StagedAuthority): Buffer {
  return Buffer.from(`${JSON.stringify(authority)}\n`, "utf8");
}

function parseStagedAuthority(bytes: Buffer): StagedAuthority {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(bytes));
  } catch {
    fail("staged authority is malformed");
  }
  const authority = value as Partial<StagedAuthority>;
  if (
    authority.schemaVersion !== CONTEXT_SCHEMA_VERSION ||
    !TRANSACTION.test(String(authority.transactionId)) ||
    !SHA256.test(String(authority.createIntentSha256)) ||
    !SHA256.test(String(authority.contextManifestSha256)) ||
    typeof authority.contextPath !== "string" ||
    !Array.isArray(authority.entries) ||
    authority.entries.length < 2 ||
    authority.entries.length > MAX_CONTEXT_ENTRIES + 1 ||
    !path.isAbsolute(authority.contextPath) ||
    CONTROL.test(authority.contextPath)
  ) {
    fail("staged authority has invalid identity fields");
  }
  const seen = new Set<string>();
  for (const candidate of authority.entries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      fail("staged authority has an invalid entry");
    }
    const entry = candidate as Partial<StagedEntry>;
    const keys = Object.keys(entry).sort();
    const expectedKeys = [
      "device",
      "inode",
      "kind",
      "mode",
      "relativePath",
      ...(entry.kind === "file" ? ["sha256", "size"] : []),
    ].sort();
    if (typeof entry.relativePath === "string" && entry.relativePath !== ".") {
      requireSafeRelativePath(entry.relativePath);
    }
    if (
      JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
      (entry.kind !== "directory" && entry.kind !== "file") ||
      typeof entry.relativePath !== "string" ||
      seen.has(entry.relativePath) ||
      !Number.isInteger(entry.mode) ||
      entry.mode! < 0 ||
      entry.mode! > 0o777 ||
      !/^[0-9]{1,40}$/u.test(String(entry.device)) ||
      !/^[0-9]{1,40}$/u.test(String(entry.inode)) ||
      (entry.kind === "file" &&
        (!Number.isSafeInteger(entry.size) ||
          entry.size! < 1 ||
          entry.size! > MAX_CONTEXT_FILE_BYTES ||
          !SHA256.test(String(entry.sha256))))
    ) {
      fail("staged authority has an invalid entry");
    }
    seen.add(entry.relativePath);
  }
  if (authority.entries[0]?.relativePath !== ".") fail("staged authority omits its root");
  return authority as StagedAuthority;
}

function assertStagedContext(
  contextPath: string,
  expected: StagedAuthority,
  sourceEntries: readonly SourceEntry[],
): void {
  const root = ensurePrivateDirectory(contextPath, false);
  const actualPaths = new Set<string>();
  const visit = (relativePath: string): void => {
    const directory = relativePath ? path.join(contextPath, relativePath) : contextPath;
    for (const member of stableDirectoryMembers(directory, relativePath || "context")) {
      const child = relativePath ? `${relativePath}/${member}` : member;
      actualPaths.add(child);
      const stat = fs.lstatSync(path.join(contextPath, child), { bigint: true });
      stat.isDirectory() && visit(child);
    }
  };
  visit("");
  const expectedEntries = expected.entries.filter((entry) => entry.relativePath !== ".");
  if (expectedEntries.length !== sourceEntries.length) {
    fail("staged authority does not cover the complete source manifest");
  }
  for (const source of sourceEntries) {
    const staged = expectedEntries.find((entry) => entry.relativePath === source.relativePath);
    if (
      !staged ||
      staged.kind !== source.kind ||
      staged.mode !== source.mode ||
      (source.kind === "file" && (staged.size !== source.size || staged.sha256 !== source.sha256))
    ) {
      fail("staged authority disagrees with the source manifest");
    }
  }
  if (actualPaths.size !== expectedEntries.length) fail("staged context membership changed");
  for (const expectedEntry of expectedEntries) {
    if (!actualPaths.has(expectedEntry.relativePath)) fail("staged context omits an entry");
    const source = sourceEntries.find((entry) => entry.relativePath === expectedEntry.relativePath);
    if (!source || source.kind !== expectedEntry.kind)
      fail("staged context authority is incomplete");
    const target = path.join(contextPath, expectedEntry.relativePath);
    const stat = fs.lstatSync(target, { bigint: true });
    if (
      stat.uid !== currentUid() ||
      String(stat.dev) !== expectedEntry.device ||
      String(stat.ino) !== expectedEntry.inode ||
      Number(stat.mode & 0o777n) !== expectedEntry.mode ||
      (stat.isFile() && stat.nlink !== 1n) ||
      (expectedEntry.kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    ) {
      fail("staged context identity changed");
    }
    if (expectedEntry.kind === "file") {
      const bytes = readPinnedStagedFile(target, expectedEntry);
      if (!bytes.equals(source.bytes!)) fail("staged context bytes disagree with source authority");
    }
  }
  if (
    String(root.dev) !== pathRootIdentity(expected).device ||
    String(root.ino) !== pathRootIdentity(expected).inode
  ) {
    fail("staged context root identity changed");
  }
}

function pathRootIdentity(authority: StagedAuthority): {
  readonly device: string;
  readonly inode: string;
} {
  const root = authority.entries.find((entry) => entry.relativePath === ".");
  if (!root) fail("staged authority omits its root identity");
  return { device: root.device, inode: root.inode };
}

function readPinnedStagedFile(filePath: string, expected: StagedEntry): Buffer {
  const descriptor = fs.openSync(filePath, OPEN_READ_FLAGS);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      String(before.dev) !== expected.device ||
      String(before.ino) !== expected.inode ||
      before.size !== BigInt(expected.size!)
    ) {
      fail("staged file identity changed");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      digest(bytes) !== expected.sha256
    ) {
      fail("staged file bytes changed");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function stagedAuthority(
  contextPath: string,
  entries: readonly StagedEntry[],
  transactionId: string,
  createIntentSha256: string,
  contextManifestSha256: string,
): StagedAuthority {
  const root = fs.lstatSync(contextPath, { bigint: true });
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    transactionId,
    createIntentSha256,
    contextManifestSha256,
    contextPath,
    entries: [
      {
        kind: "directory",
        relativePath: ".",
        mode: Number(root.mode & 0o777n),
        device: String(root.dev),
        inode: String(root.ino),
      },
      ...entries,
    ],
  };
}

function removeExactContextTree(
  contextPath: string,
  sourceEntries: readonly SourceEntry[],
  persisted: StagedAuthority | null,
): void {
  const sources = new Map(sourceEntries.map((entry) => [entry.relativePath, entry]));
  const staged = new Map(
    (persisted?.entries ?? [])
      .filter((entry) => entry.relativePath !== ".")
      .map((entry) => [entry.relativePath, entry]),
  );
  const rootBefore = fs.lstatSync(contextPath, { bigint: true });
  const expectedRoot = persisted ? pathRootIdentity(persisted) : null;
  if (
    !rootBefore.isDirectory() ||
    rootBefore.isSymbolicLink() ||
    rootBefore.uid !== currentUid() ||
    (rootBefore.mode & 0o777n) !== 0o700n ||
    (expectedRoot &&
      (String(rootBefore.dev) !== expectedRoot.device ||
        String(rootBefore.ino) !== expectedRoot.inode))
  ) {
    fail("context cleanup root identity is unsafe");
  }
  const removeDirectory = (relativePath: string): void => {
    const directory = relativePath ? path.join(contextPath, relativePath) : contextPath;
    const directoryBefore = fs.lstatSync(directory, { bigint: true });
    const expectedDirectory = relativePath ? staged.get(relativePath) : null;
    if (
      !directoryBefore.isDirectory() ||
      directoryBefore.isSymbolicLink() ||
      directoryBefore.uid !== currentUid() ||
      (expectedDirectory &&
        (expectedDirectory.kind !== "directory" ||
          String(directoryBefore.dev) !== expectedDirectory.device ||
          String(directoryBefore.ino) !== expectedDirectory.inode ||
          Number(directoryBefore.mode & 0o777n) !== expectedDirectory.mode))
    ) {
      fail("context cleanup directory identity changed");
    }
    const members = fs.readdirSync(directory).sort();
    for (const member of members) {
      const child = relativePath ? `${relativePath}/${member}` : member;
      const target = path.join(contextPath, child);
      const source = sources.get(child);
      const expected = staged.get(child);
      const named = fs.lstatSync(target, { bigint: true });
      if (
        !source ||
        (persisted && !expected) ||
        named.isSymbolicLink() ||
        named.uid !== currentUid()
      ) {
        fail("context cleanup found foreign evidence");
      }
      if (source.kind === "directory" && named.isDirectory()) {
        removeDirectory(child);
        continue;
      }
      if (source.kind !== "file" || !named.isFile() || named.nlink !== 1n) {
        fail("context cleanup entry type disagrees");
      }
      const descriptor = fs.openSync(target, OPEN_READ_FLAGS);
      try {
        const before = fs.fstatSync(descriptor, { bigint: true });
        const maximumSize = persisted
          ? BigInt(source.bytes!.byteLength)
          : BigInt(source.bytes!.byteLength);
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size > maximumSize ||
          named.dev !== before.dev ||
          named.ino !== before.ino ||
          (expected &&
            (expected.kind !== "file" ||
              String(before.dev) !== expected.device ||
              String(before.ino) !== expected.inode ||
              before.size !== BigInt(expected.size!)))
        ) {
          fail("context cleanup file identity changed");
        }
        const bytes = fs.readFileSync(descriptor);
        const fullMatch = bytes.equals(source.bytes!);
        const prefixMatch = source.bytes!.subarray(0, bytes.byteLength).equals(bytes);
        if ((persisted && !fullMatch) || (!persisted && !prefixMatch)) {
          fail("context cleanup file bytes disagree");
        }
        const after = fs.fstatSync(descriptor, { bigint: true });
        const finalNamed = fs.lstatSync(target, { bigint: true });
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          finalNamed.dev !== after.dev ||
          finalNamed.ino !== after.ino
        ) {
          fail("context cleanup file changed before removal");
        }
        fs.unlinkSync(target);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    const directoryAfter = fs.lstatSync(directory, { bigint: true });
    if (
      directoryBefore.dev !== directoryAfter.dev ||
      directoryBefore.ino !== directoryAfter.ino ||
      fs.readdirSync(directory).length !== 0
    ) {
      fail("context cleanup directory changed before removal");
    }
    fs.rmdirSync(directory);
  };
  removeDirectory("");
  fsyncDirectory(path.dirname(contextPath));
}

function materializeContext(
  sourceEntries: readonly SourceEntry[],
  authority: HermesPortableBuildContextAuthority,
  input: Parameters<HermesPortableBuildContextPlan["materialize"]>[0],
): HermesPortableStagedBuildContext {
  const paths = contextPaths(
    input.stateDir,
    input.sandboxName,
    input.transactionId,
    input.createIntentSha256,
  );
  prepareTransactionDirectory(paths);
  if (fs.existsSync(paths.retired))
    fail("retired build context cannot be reused for pending create");
  let persisted: StagedAuthority;
  if (fs.existsSync(paths.authority) || fs.existsSync(paths.authorityNext)) {
    const authorityPath = fs.existsSync(paths.authority) ? paths.authority : paths.authorityNext;
    const expectedLinks =
      fs.existsSync(paths.authority) && fs.existsSync(paths.authorityNext) ? 2n : 1n;
    persisted = parseStagedAuthority(readPrivateFile(authorityPath, expectedLinks));
    assertStagedContext(paths.context, persisted, sourceEntries);
    publishPrivateEvidence(
      paths.authority,
      paths.authorityNext,
      serializeStagedAuthority(persisted),
      paths.directory,
    );
  } else {
    if (fs.existsSync(paths.context)) removeExactContextTree(paths.context, sourceEntries, null);
    const entries = stageEntries(paths.context, sourceEntries);
    persisted = stagedAuthority(
      paths.context,
      entries,
      input.transactionId,
      input.createIntentSha256,
      authority.contextManifestSha256,
    );
    publishPrivateEvidence(
      paths.authority,
      paths.authorityNext,
      serializeStagedAuthority(persisted),
      paths.directory,
    );
  }
  if (
    persisted.transactionId !== input.transactionId ||
    persisted.createIntentSha256 !== input.createIntentSha256 ||
    persisted.contextManifestSha256 !== authority.contextManifestSha256 ||
    persisted.contextPath !== paths.context
  ) {
    fail("published context authority disagrees with the current transaction");
  }
  const assertCurrent = (): void => assertStagedContext(paths.context, persisted, sourceEntries);
  assertCurrent();
  return {
    buildContextPath: paths.context,
    dockerfilePath: path.join(paths.context, authority.dockerfileRelativePath),
    assertCurrent,
  };
}

function retireContext(
  sourceEntries: readonly SourceEntry[],
  authority: HermesPortableBuildContextAuthority,
  input: Parameters<HermesPortableBuildContextPlan["retire"]>[0],
): boolean {
  const paths = contextPaths(
    input.stateDir,
    input.sandboxName,
    input.transactionId,
    input.createIntentSha256,
  );
  prepareTransactionDirectory(paths);
  const persisted = parseStagedAuthority(readPrivateFile(paths.authority));
  if (
    persisted.transactionId !== input.transactionId ||
    persisted.createIntentSha256 !== input.createIntentSha256 ||
    persisted.contextManifestSha256 !== authority.contextManifestSha256
  ) {
    fail("cleanup authority disagrees with the current transaction");
  }
  const retiredBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, authoritySha256: digest(serializeStagedAuthority(persisted)) })}\n`,
  );
  const retiredNext = `${paths.retired}.next`;
  const retiredExists = fs.existsSync(paths.retired) || fs.existsSync(retiredNext);
  if (fs.existsSync(paths.context) && fs.existsSync(paths.retiring)) {
    fail("context cleanup has ambiguous canonical and detached evidence");
  }
  if (!retiredExists) {
    if (fs.existsSync(paths.retiring)) {
      const renamed = { ...persisted, contextPath: paths.retiring };
      assertStagedContext(paths.retiring, renamed, sourceEntries);
    } else {
      assertStagedContext(paths.context, persisted, sourceEntries);
      fs.renameSync(paths.context, paths.retiring);
      const renamed = { ...persisted, contextPath: paths.retiring };
      assertStagedContext(paths.retiring, renamed, sourceEntries);
    }
    publishPrivateEvidence(paths.retired, retiredNext, retiredBytes, paths.directory);
  } else {
    publishPrivateEvidence(paths.retired, retiredNext, retiredBytes, paths.directory);
    if (fs.existsSync(paths.context)) fail("retired evidence has a canonical context");
  }
  if (fs.existsSync(paths.retiring)) {
    const renamed = { ...persisted, contextPath: paths.retiring };
    removeExactContextTree(paths.retiring, sourceEntries, renamed);
  }
  if (fs.existsSync(paths.context)) fail("canonical context remains after retirement");
  return true;
}

/** Capture the exact shipped Hermes build inputs without creating filesystem state. */
export function createHermesPortableBuildContextPlan(
  rootPath: string,
  settings: HermesPortableBuildContextSettings,
): HermesPortableBuildContextPlan {
  const captured = capture(rootPath, settings);
  const assertCurrentSource = (): void => {
    const current = capture(rootPath, settings);
    if (JSON.stringify(current.authority) !== JSON.stringify(captured.authority)) {
      fail("source authority changed after reservation");
    }
  };
  return {
    authority: captured.authority,
    sourceDockerfilePath: path.join(rootPath, SOURCE_DOCKERFILE_RELATIVE_PATH),
    assertCurrentSource,
    materialize: (input) => {
      assertCurrentSource();
      return materializeContext(captured.contextEntries, captured.authority, input);
    },
    retire: (input) => retireContext(captured.contextEntries, captured.authority, input),
  };
}
