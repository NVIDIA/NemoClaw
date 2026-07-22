// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
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

export function assertOpenShellGatewayAuthArtifactsSafe(rootDir: string): void {
  const root = path.resolve(rootDir);
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${relativePath}': non-regular file`,
        );
      }
      if (
        /^(?:.*\/)?jwt\/(?:signing\.pem|kid)$|(?:^|\/)openshell-gateway\.toml$/i.test(relativePath)
      ) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${relativePath}': sensitive auth file name`,
        );
      }
      const content = fs.readFileSync(absolutePath, "utf-8");
      const forbidden = FORBIDDEN_AUTH_ARTIFACT_CONTENT.find(({ pattern }) =>
        pattern.test(content),
      );
      if (forbidden) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${relativePath}': ${forbidden.label}`,
        );
      }
    }
  };
  visit(root);
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
        fs.rmSync(quarantineRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

function copyApprovedArtifacts(sourceRoot: string, approvedRoot: string): void {
  const copyRegularFile = (sourcePath: string, approvedPath: string): void => {
    const source = fs.openSync(sourcePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const approved = fs.openSync(
      approvedPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      const sourceStat = fs.fstatSync(source);
      if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
        throw new Error(`${sourcePath} must be a single-link regular file`);
      }
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let count = fs.readSync(source, buffer, 0, buffer.length, null);
      while (count > 0) {
        let written = 0;
        while (written < count) {
          written += fs.writeSync(approved, buffer, written, count - written);
        }
        count = fs.readSync(source, buffer, 0, buffer.length, null);
      }
      fs.fchmodSync(approved, 0o600);
      fs.fsyncSync(approved);
    } finally {
      fs.closeSync(approved);
      fs.closeSync(source);
    }
  };
  const copy = (sourceDir: string, approvedDir: string): void => {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDir, entry.name);
      const approvedPath = path.join(approvedDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(approvedPath, { mode: 0o700 });
        copy(sourcePath, approvedPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Unsafe OpenShell auth-contract artifact '${entry.name}': non-regular file`,
        );
      }
      copyRegularFile(sourcePath, approvedPath);
    }
  };
  copy(sourceRoot, approvedRoot);
}

export function scanAndApproveOpenShellGatewayAuthArtifacts(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let approvedRoot: string | undefined;
  try {
    assertOpenShellGatewayAuthArtifactsSafe(rootDir);
    approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approved-auth-artifacts-"), {
      encoding: "utf8",
    });
    fs.chmodSync(approvedRoot, 0o700);
    copyApprovedArtifacts(path.resolve(rootDir), approvedRoot);
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
