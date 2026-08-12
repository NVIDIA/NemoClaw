// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { parse as parseYaml } from "yaml";

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
  isCredentialField,
  isDependencyLockfile,
  isSensitiveFile,
  sanitizeConfigFileContent,
  sanitizeEnvFileContent,
  valueLooksLikeSecret,
} from "./credential-filter";

const MAX_SANITIZATION_PASSES = 3;

const VENDORED_DEPENDENCY_DIRECTORY = "node_modules";
const DEPENDENCY_MANIFEST_NAME = "package.json";
const DEPENDENCY_NAME_MAP_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "packages",
]);

function isDependencyCredentialField(key: string): boolean {
  const normalized = key.replace(/^_+/, "");
  return normalized.toLowerCase() === "auth" || isCredentialField(normalized);
}

function dependencyStringContainsCredential(value: string): boolean {
  const candidates = value.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  let nonUrlContent = value;
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return true;
      for (const [key, queryValue] of url.searchParams) {
        if (queryValue && isDependencyCredentialField(key)) return true;
      }
      nonUrlContent = nonUrlContent.replace(candidate, "");
    } catch {
      // Malformed dependency URLs are handled by the package manager. They do
      // not become a credential finding unless a bounded detector above fires.
    }
  }
  return valueLooksLikeSecret(nonUrlContent);
}

function dependencyValueContainsCredential(value: unknown, parentField?: string): boolean {
  if (typeof value === "string") return dependencyStringContainsCredential(value);
  if (Array.isArray(value)) {
    return value.some((entry) => dependencyValueContainsCredential(entry));
  }
  if (value === null || typeof value !== "object") return false;

  const keysAreDependencyNames =
    parentField !== undefined && DEPENDENCY_NAME_MAP_FIELDS.has(parentField);
  for (const [key, child] of Object.entries(value)) {
    if (
      !keysAreDependencyNames &&
      isDependencyCredentialField(key) &&
      child !== null &&
      child !== undefined &&
      child !== ""
    ) {
      return true;
    }
    if (dependencyValueContainsCredential(child, key)) return true;
  }
  return false;
}

function dependencyLockfileContainsCredential(name: string, raw: string): boolean {
  if (dependencyStringContainsCredential(raw)) return true;
  let parsed: unknown;
  try {
    parsed = name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  } catch {
    // Preserve a recognized lockfile only after inspection with the parser for
    // its format. Invalid content could otherwise carry an opaque credential
    // that the bounded text detectors do not recognize.
    return true;
  }
  return dependencyValueContainsCredential(parsed);
}

function dependencyManifestContainsCredential(raw: string): boolean {
  if (dependencyStringContainsCredential(raw)) return true;
  try {
    return dependencyValueContainsCredential(JSON.parse(raw));
  } catch {
    // Installed package manifests are JSON. Preserve only documents whose
    // structure was inspected successfully; an unparseable manifest cannot
    // receive the dependency-name-key exemption safely.
    return true;
  }
}

/**
 * Whether a scanned file is an installed package manifest that requires
 * dependency-aware credential inspection.
 *
 * Package names are object keys in an installed package's own manifest. The
 * ordinary credential key matcher therefore reads `cookie`, `js-tokens`, and
 * `path-key` as secrets and replaces the versions they resolve to. `npm install`
 * then fails. The structured inspection exempts only those dependency-map
 * keys while continuing to reject credential-bearing fields and values.
 */
function isVendoredDependencyManifest(filePath: string, basename: string): boolean {
  return (
    filePath.split("/").includes(VENDORED_DEPENDENCY_DIRECTORY) &&
    basename === DEPENDENCY_MANIFEST_NAME
  );
}

function actionForScannedFile(file: SnapshotScannedFile): SnapshotSanitizationAction | null {
  const name = path.posix.basename(file.path).toLowerCase();
  if (isSensitiveFile(name)) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }
  const raw = decodeDescriptorSnapshotContent(file.content);
  if (raw === null) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }

  if (isDependencyLockfile(name)) {
    return dependencyLockfileContainsCredential(name, raw)
      ? { kind: "remove", path: file.path, metadata: file.metadata }
      : null;
  }
  // Runs after the sensitive-basename and lockfile credential checks. Only an
  // installed package manifest uses the dependency-aware credential check.
  if (isVendoredDependencyManifest(file.path, name)) {
    return dependencyManifestContainsCredential(raw)
      ? { kind: "remove", path: file.path, metadata: file.metadata }
      : null;
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
