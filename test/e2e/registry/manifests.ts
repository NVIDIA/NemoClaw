// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { NemoClawInstanceManifest } from "./types.ts";

export interface LoadedManifest {
  filePath: string;
  document: NemoClawInstanceManifest;
}

const FORBIDDEN_PRODUCT_FIELDS = new Set([
  "assertion",
  "assertions",
  "assertionGroups",
  "assertionGroupIds",
  "suite",
  "suites",
  "suiteIds",
  "testPlan",
  "testPlans",
]);

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|credential)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, fieldPath: string, filePath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${filePath}: ${fieldPath} must be an object`);
  }
  return value;
}

function assertString(
  value: unknown,
  fieldPath: string,
  filePath: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${filePath}: ${fieldPath} must be a non-empty string`);
  }
}

function scanProductOnly(value: unknown, filePath: string, fieldPath = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanProductOnly(entry, filePath, `${fieldPath}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PRODUCT_FIELDS.has(key)) {
      throw new Error(
        `${filePath}: ${fieldPath}.${key} is test assertion/suite metadata; manifests are product-facing only`,
      );
    }
    if (
      SECRET_KEY_PATTERN.test(key) &&
      key !== "credentialRefs" &&
      typeof child === "string" &&
      child.trim() !== ""
    ) {
      throw new Error(
        `${filePath}: ${fieldPath}.${key} looks like a raw secret; use state.credentialRefs instead`,
      );
    }
    scanProductOnly(child, filePath, `${fieldPath}.${key}`);
  }
}

function validateCredentialRefs(state: Record<string, unknown> | undefined, filePath: string) {
  const refs = state?.credentialRefs;
  if (refs === undefined) {
    return;
  }
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
    throw new Error(`${filePath}: spec.state.credentialRefs must be a string array`);
  }
}

export function validateManifest(
  document: unknown,
  filePath = "manifest",
): asserts document is NemoClawInstanceManifest {
  const root = asRecord(document, "manifest", filePath);
  if (root.apiVersion !== "nemoclaw.io/v1") {
    throw new Error(`${filePath}: apiVersion must be nemoclaw.io/v1`);
  }
  if (root.kind !== "NemoClawInstance") {
    throw new Error(`${filePath}: kind must be NemoClawInstance`);
  }
  const metadata = asRecord(root.metadata, "metadata", filePath);
  assertString(metadata.name, "metadata.name", filePath);
  const spec = asRecord(root.spec, "spec", filePath);
  asRecord(spec.setup, "spec.setup", filePath);
  asRecord(spec.onboarding, "spec.onboarding", filePath);
  const state = spec.state === undefined ? undefined : asRecord(spec.state, "spec.state", filePath);
  validateCredentialRefs(state, filePath);
  scanProductOnly(root, filePath);
}

export function loadManifest(filePath: string): LoadedManifest {
  const document = yaml.load(fs.readFileSync(filePath, "utf8"));
  validateManifest(document, filePath);
  return { filePath, document };
}

export function loadManifestsFromDir(directory: string): LoadedManifest[] {
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
    .sort()
    .map((entry) => loadManifest(path.join(directory, entry)));
}
