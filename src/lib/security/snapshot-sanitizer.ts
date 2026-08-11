// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  applyDescriptorSnapshotActions,
  decodeDescriptorSnapshotContent,
  inspectDescriptorSnapshotRoot,
  type SnapshotSanitizationAction,
  type SnapshotScannedFile,
  scanDescriptorSnapshot,
} from "../../../nemoclaw/dist/shared/snapshot-sanitizer-boundary.cjs";

import {
  CREDENTIAL_SENSITIVE_BASENAMES,
  isDependencyLockfile,
  isSensitiveFile,
  sanitizeConfigFileContent,
  sanitizeEnvFileContent,
} from "./credential-filter";

const MAX_SANITIZATION_PASSES = 3;

const VENDORED_DEPENDENCY_DIRECTORY = "node_modules";

/**
 * Whether a scanned file is machine-generated dependency material rather than
 * an artifact an operator or agent writes credentials into.
 *
 * Package names are object keys in a lockfile and in an installed package's own
 * manifest. The credential key matcher therefore reads `cookie`, `js-tokens`,
 * and `path-key` as secrets and replaces the versions they resolve to.
 * `npm install` then fails. That failure is not a credential control; it
 * corrupts the dependency tree that the sandbox restores.
 * `shouldScanSnapshotFileForCredentials` already excludes lockfiles from the
 * leak check for the same reason.
 */
function isVendoredDependencyArtifact(filePath: string, basename: string): boolean {
  if (isDependencyLockfile(basename)) return true;
  return filePath.split("/").includes(VENDORED_DEPENDENCY_DIRECTORY);
}

function actionForScannedFile(file: SnapshotScannedFile): SnapshotSanitizationAction | null {
  const name = path.posix.basename(file.path).toLowerCase();
  if (isSensitiveFile(name)) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }
  // Runs after the sensitive-basename check so a `CREDENTIAL_SENSITIVE_BASENAMES`
  // file inside a dependency tree is still removed.
  if (isVendoredDependencyArtifact(file.path, name)) return null;

  const raw = decodeDescriptorSnapshotContent(file.content);
  if (raw === null) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }

  let sanitized: string | null;
  if (name === ".env" || name.endsWith(".env")) {
    sanitized = sanitizeEnvFileContent(raw);
  } else {
    sanitized = sanitizeConfigFileContent(name, raw);
  }
  if (sanitized === null) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }
  const hasRestrictedMode = (Number(file.metadata.mode) & 0o777) === 0o600;
  if (sanitized === raw && hasRestrictedMode) return null;
  return {
    kind: "replace",
    path: file.path,
    metadata: file.metadata,
    content: Buffer.from(sanitized, "utf-8").toString("base64"),
  };
}

/**
 * Sanitize every credential-bearing artifact beneath a copied snapshot root.
 *
 * Both discovery and mutation use the shared descriptor-relative helper. A
 * directory or file that changes after inspection therefore fails closed
 * instead of redirecting the sanitizer outside the snapshot root.
 */
export function sanitizeSnapshotDirectory(rootPath: string): void {
  for (let pass = 0; pass < MAX_SANITIZATION_PASSES; pass += 1) {
    const root = inspectDescriptorSnapshotRoot(rootPath);
    if (root === null) {
      if (pass === 0) return;
      throw new Error(`Failed to inspect snapshot artifacts safely: ${rootPath}`);
    }

    const scan = scanDescriptorSnapshot(root, CREDENTIAL_SENSITIVE_BASENAMES);
    if (scan === null) {
      throw new Error(`Failed to inspect snapshot artifacts safely: ${rootPath}`);
    }
    const actions = scan.files
      .map((file) => actionForScannedFile(file))
      .filter((action): action is SnapshotSanitizationAction => action !== null);
    if (actions.length === 0) return;
    if (!applyDescriptorSnapshotActions(root, scan, actions)) {
      throw new Error(`Failed to sanitize snapshot artifacts safely: ${rootPath}`);
    }
  }
  throw new Error(`Snapshot artifacts did not reach a stable sanitized state: ${rootPath}`);
}
