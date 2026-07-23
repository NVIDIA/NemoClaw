// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_ARTIFACT_SAFETY_RUN_ID = `local-${process.pid}`;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

const FORBIDDEN_AUTH_ARTIFACT_CONTENT: Array<{ label: string; pattern: RegExp }> = [
  { label: "authorization header", pattern: /["']?authorization["']?\s*[:=]/i },
  {
    label: "Bearer JWT",
    pattern: /\bBearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  },
  { label: "JWT signing-key path", pattern: /(?:^|[/\\])jwt[/\\]signing\.pem\b/i },
  { label: "JWT key-id path", pattern: /(?:^|[/\\])jwt[/\\]kid\b/i },
  { label: "gateway auth config path", pattern: /\bopenshell-gateway\.toml\b/i },
  {
    label: "gateway JWT configuration",
    pattern: /\[openshell\.gateway\.gateway_jwt\]/i,
  },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

type ArtifactEntryKind = "directory" | "file";

type ScannedArtifactEntry = {
  children?: string[];
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  kind: ArtifactEntryKind;
  mode: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  relativePath: string;
  sha256?: string;
  size: bigint;
};

type ScannedArtifactManifest = Map<string, ScannedArtifactEntry>;

function displayArtifactPath(relativePath: string): string {
  return relativePath || ".";
}

function artifactEntryKind(stat: BigIntStats): ArtifactEntryKind | null {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return null;
}

function artifactEntryIdentity(
  stat: BigIntStats,
  kind: ArtifactEntryKind,
  relativePath: string,
): ScannedArtifactEntry {
  return {
    ctimeNs: stat.ctimeNs,
    dev: stat.dev,
    ino: stat.ino,
    kind,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    nlink: stat.nlink,
    relativePath,
    size: stat.size,
  };
}

function assertEntryIdentity(stat: BigIntStats, expected: ScannedArtifactEntry): void {
  if (
    artifactEntryKind(stat) !== expected.kind ||
    stat.ctimeNs !== expected.ctimeNs ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    stat.mode !== expected.mode ||
    stat.mtimeNs !== expected.mtimeNs ||
    stat.nlink !== expected.nlink ||
    stat.size !== expected.size
  ) {
    throw new Error(
      `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(expected.relativePath)}': ` +
        "entry identity changed during safety approval",
    );
  }
}

function lstatEntry(entryPath: string): BigIntStats {
  return fs.lstatSync(entryPath, { bigint: true });
}

function fstatEntry(fileDescriptor: number): BigIntStats {
  return fs.fstatSync(fileDescriptor, { bigint: true });
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readDirectoryNames(directoryPath: string): string[] {
  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
}

function assertDirectoryNames(actual: readonly string[], expected: ScannedArtifactEntry): void {
  if (
    !expected.children ||
    actual.length !== expected.children.length ||
    actual.some((name, index) => name !== expected.children?.[index])
  ) {
    throw new Error(
      `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(expected.relativePath)}': ` +
        "directory entries changed during safety approval",
    );
  }
}

function scanOpenShellGatewayAuthArtifacts(rootDir: string): ScannedArtifactManifest {
  const root = path.resolve(rootDir);
  const rootStat = lstatEntry(root);
  if (!rootStat.isDirectory()) {
    throw new Error("Unsafe OpenShell auth-contract artifact '.': non-directory root");
  }
  const scannedRoot = artifactEntryIdentity(rootStat, "directory", "");
  const rootRealPath = fs.realpathSync(root);
  assertEntryIdentity(lstatEntry(root), scannedRoot);
  const manifest: ScannedArtifactManifest = new Map();
  const assertContained = (absolutePath: string, relativePath: string): void => {
    const realPath = fs.realpathSync(absolutePath);
    if (realPath !== rootRealPath && !realPath.startsWith(`${rootRealPath}${path.sep}`)) {
      throw new Error(
        `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(relativePath)}': ` +
          "entry resolves outside the artifact root",
      );
    }
  };
  const visit = (absolutePath: string, relativePath: string): void => {
    const before = lstatEntry(absolutePath);
    if (!relativePath) {
      assertEntryIdentity(before, scannedRoot);
    }
    const kind = artifactEntryKind(before);
    if (!kind) {
      throw new Error(
        `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(relativePath)}': ` +
          "non-regular file",
      );
    }
    assertContained(absolutePath, relativePath);
    const scanned = artifactEntryIdentity(before, kind, relativePath);
    manifest.set(relativePath, scanned);

    if (kind === "directory") {
      const names = readDirectoryNames(absolutePath);
      scanned.children = names;
      assertEntryIdentity(lstatEntry(absolutePath), scanned);
      assertContained(absolutePath, relativePath);
      assertDirectoryNames(readDirectoryNames(absolutePath), scanned);
      for (const name of names) {
        const childPath = path.join(absolutePath, name);
        const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
        visit(childPath, childRelativePath);
      }
      assertEntryIdentity(lstatEntry(absolutePath), scanned);
      assertContained(absolutePath, relativePath);
      assertDirectoryNames(readDirectoryNames(absolutePath), scanned);
      assertEntryIdentity(lstatEntry(absolutePath), scanned);
      return;
    }

    if (
      /^(?:.*\/)?jwt\/(?:signing\.pem|kid)$|(?:^|\/)openshell-gateway\.toml$/i.test(relativePath)
    ) {
      throw new Error(
        `Unsafe OpenShell auth-contract artifact '${relativePath}': sensitive auth file name`,
      );
    }
    const source = fs.openSync(absolutePath, fs.constants.O_RDONLY | NO_FOLLOW);
    let content: Buffer;
    try {
      const sourceBeforeRead = fstatEntry(source);
      assertEntryIdentity(sourceBeforeRead, scanned);
      if (sourceBeforeRead.nlink !== 1n) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${relativePath}': regular file must have one link`,
        );
      }
      content = fs.readFileSync(source);
      assertEntryIdentity(fstatEntry(source), scanned);
      scanned.sha256 = sha256(content);
    } finally {
      fs.closeSync(source);
    }
    assertEntryIdentity(lstatEntry(absolutePath), scanned);
    assertContained(absolutePath, relativePath);
    const decodedContent = content.toString("utf8");
    const forbidden = FORBIDDEN_AUTH_ARTIFACT_CONTENT.find(({ pattern }) =>
      pattern.test(decodedContent),
    );
    if (forbidden) {
      throw new Error(
        `Unsafe OpenShell auth-contract artifact '${relativePath}': ${forbidden.label}`,
      );
    }
  };
  visit(root, "");
  return manifest;
}

export function assertOpenShellGatewayAuthArtifactsSafe(rootDir: string): void {
  scanOpenShellGatewayAuthArtifacts(rootDir);
}

function quarantineUnsafeOpenShellGatewayAuthArtifacts(rootDir: string): void {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return;

  let quarantineRoot: string | undefined;
  let moved = false;
  try {
    quarantineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unsafe-auth-artifacts-"));
    fs.chmodSync(quarantineRoot, 0o700);
    fs.renameSync(root, path.join(quarantineRoot, "artifacts"));
    moved = true;
  } catch {
    // Cross-device or restricted temp-directory moves can fail. Deleting the
    // upload source still keeps rejected evidence outside the publication path.
  }

  if (!moved) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      if (fs.existsSync(root)) {
        throw new Error("Unsafe OpenShell auth-contract artifacts could not be deleted");
      }
    } finally {
      if (quarantineRoot) {
        fs.rmSync(quarantineRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      }
    }
    return;
  }

  if (!quarantineRoot) {
    throw new Error("Unsafe OpenShell auth-contract quarantine path was not created");
  }
  try {
    fs.rmSync(quarantineRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (cause) {
    throw new Error(
      "Unsafe OpenShell auth-contract artifacts were quarantined outside the upload path but could not be deleted",
      { cause },
    );
  }
}

function rejectAndQuarantine(rootDir: string, error: unknown): never {
  try {
    quarantineUnsafeOpenShellGatewayAuthArtifacts(rootDir);
  } catch (quarantineError) {
    throw new AggregateError(
      [error, quarantineError],
      "OpenShell auth-contract artifacts failed safety approval and quarantine",
    );
  }
  throw error;
}

export function enforceOpenShellGatewayAuthArtifactSafety(rootDir: string): void {
  try {
    assertOpenShellGatewayAuthArtifactsSafe(rootDir);
  } catch (error) {
    rejectAndQuarantine(rootDir, error);
  }
}

export function openShellGatewayAuthArtifactSafetyMarkerName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const runId = /^\d+$/.test(env.GITHUB_RUN_ID ?? "")
    ? String(env.GITHUB_RUN_ID)
    : LOCAL_ARTIFACT_SAFETY_RUN_ID;
  const runAttempt = /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
    ? String(env.GITHUB_RUN_ATTEMPT)
    : "1";
  return `artifact-safety-${runId}-${runAttempt}.passed`;
}

function copyApprovedArtifacts(
  sourceRoot: string,
  approvedRoot: string,
  manifest: ScannedArtifactManifest,
): void {
  const manifestEntry = (relativePath: string, kind: ArtifactEntryKind): ScannedArtifactEntry => {
    const entry = manifest.get(relativePath);
    if (!entry || entry.kind !== kind) {
      throw new Error(
        `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(relativePath)}': ` +
          "scanned entry is unavailable during safety approval",
      );
    }
    return entry;
  };
  const sourcePathFor = (relativePath: string): string =>
    relativePath ? path.join(sourceRoot, ...relativePath.split("/")) : sourceRoot;
  const copyRegularFile = (
    sourcePath: string,
    approvedPath: string,
    expected: ScannedArtifactEntry,
  ): void => {
    if (!expected.sha256) {
      throw new Error(
        `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(expected.relativePath)}': ` +
          "scanned content digest is unavailable during safety approval",
      );
    }
    assertEntryIdentity(lstatEntry(sourcePath), expected);
    const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      const sourceStat = fstatEntry(source);
      assertEntryIdentity(sourceStat, expected);
      if (sourceStat.nlink !== 1n) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(expected.relativePath)}': ` +
            "regular file must have one link",
        );
      }
      const approved = fs.openSync(
        approvedPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      try {
        const copiedHash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let count = fs.readSync(source, buffer, 0, buffer.length, null);
        while (count > 0) {
          copiedHash.update(buffer.subarray(0, count));
          let written = 0;
          while (written < count) {
            written += fs.writeSync(approved, buffer, written, count - written);
          }
          count = fs.readSync(source, buffer, 0, buffer.length, null);
        }
        if (copiedHash.digest("hex") !== expected.sha256) {
          throw new Error(
            `Unsafe OpenShell auth-contract artifact '${displayArtifactPath(expected.relativePath)}': ` +
              "file content changed during safety approval",
          );
        }
        fs.fchmodSync(approved, 0o600);
        fs.fsyncSync(approved);
        assertEntryIdentity(fstatEntry(source), expected);
      } finally {
        fs.closeSync(approved);
      }
    } finally {
      fs.closeSync(source);
    }
    assertEntryIdentity(lstatEntry(sourcePath), expected);
  };
  const copy = (relativePath: string, approvedDir: string): void => {
    const expectedDirectory = manifestEntry(relativePath, "directory");
    const sourceDir = sourcePathFor(relativePath);
    assertEntryIdentity(lstatEntry(sourceDir), expectedDirectory);
    assertDirectoryNames(readDirectoryNames(sourceDir), expectedDirectory);
    assertEntryIdentity(lstatEntry(sourceDir), expectedDirectory);
    for (const name of expectedDirectory.children ?? []) {
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const expectedChild = manifest.get(childRelativePath);
      if (!expectedChild) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${childRelativePath}': ` +
            "scanned entry is unavailable during safety approval",
        );
      }
      const sourcePath = sourcePathFor(childRelativePath);
      const approvedPath = path.join(approvedDir, name);
      if (expectedChild.kind === "directory") {
        assertEntryIdentity(lstatEntry(sourcePath), expectedChild);
        fs.mkdirSync(approvedPath, { mode: 0o700 });
        copy(childRelativePath, approvedPath);
        continue;
      }
      copyRegularFile(sourcePath, approvedPath, expectedChild);
    }
    assertEntryIdentity(lstatEntry(sourceDir), expectedDirectory);
    assertDirectoryNames(readDirectoryNames(sourceDir), expectedDirectory);
    assertEntryIdentity(lstatEntry(sourceDir), expectedDirectory);
  };
  copy("", approvedRoot);
}

export function scanAndApproveOpenShellGatewayAuthArtifacts(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let approvedRoot: string | undefined;
  try {
    const manifest = scanOpenShellGatewayAuthArtifacts(rootDir);
    approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approved-auth-artifacts-"), {
      encoding: "utf8",
    });
    fs.chmodSync(approvedRoot, 0o700);
    copyApprovedArtifacts(path.resolve(rootDir), approvedRoot, manifest);
    assertOpenShellGatewayAuthArtifactsSafe(approvedRoot);
    const safetyMarker = path.join(approvedRoot, openShellGatewayAuthArtifactSafetyMarkerName(env));
    fs.writeFileSync(safetyMarker, "approved\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return approvedRoot;
  } catch (error) {
    if (approvedRoot) {
      fs.rmSync(approvedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    rejectAndQuarantine(rootDir, error);
  }
}

function runCli(): void {
  const [rootDir, ...extra] = process.argv.slice(2);
  if (!rootDir || extra.length > 0) {
    throw new Error(
      "Usage: node --experimental-strip-types tools/e2e/openshell-gateway-auth-artifact-safety.mts <artifact-root>",
    );
  }
  const approvedRoot = scanAndApproveOpenShellGatewayAuthArtifacts(rootDir);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `approved_path=${approvedRoot}\n`, "utf8");
  }
  process.stdout.write(
    `OpenShell gateway auth artifacts copied to approved staging: ${path.basename(approvedRoot)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact safety scan failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
