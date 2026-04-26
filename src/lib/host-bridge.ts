// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { ensureConfigDir } from "./config-io";

export const SUPPORTED_HOST_BRIDGE = "codex-version";
export const CODEX_VERSION_SERVICE_NAME = "codex-bridge.local";
export const CODEX_VERSION_POLICY_NAME = "codex_bridge";
export const CODEX_VERSION_SERVICE_PORT = 80;
export const CODEX_VERSION_TARGET_SCHEME = "http";
export const CODEX_VERSION_TARGET_HOST = "127.0.0.1";
export const CODEX_VERSION_TARGET_PORT = 36566;
export const CODEX_VERSION_TARGET_PATH = "/codex_version";
export const CODEX_VERSION_BINARY = "/usr/bin/curl";

export function getHostBridgeStateDir(): string {
  return path.join(process.env.HOME || os.tmpdir(), ".nemoclaw", "state", "host-bridges");
}

export interface HostBridgeBinary {
  path: string;
}

export interface HostBridgeRule {
  allow: {
    method: string;
    path: string;
  };
}

export interface HostBridgeRegistration {
  version: number;
  sandbox: string;
  service_name: string;
  service_port: number;
  target_scheme: string;
  target_host: string;
  target_port: number;
  target_path: string;
  protocol: string;
  enforcement: string;
  rules: HostBridgeRule[];
  binaries?: HostBridgeBinary[];
}

export interface HostBridgeEvidencePaths {
  dir: string;
  policyBeforePath: string;
  policyAfterPath: string;
  registrationPath: string;
  revertScriptPath: string;
  validationNotesPath: string;
}

type HostBridgeOperation = "add" | "remove";

function baseRules(): HostBridgeRule[] {
  return [
    {
      allow: {
        method: "POST",
        path: CODEX_VERSION_TARGET_PATH,
      },
    },
  ];
}

function parseCurrentPolicyDocument(raw = ""): string {
  if (!raw) return "";
  const sep = raw.indexOf("---");
  const candidate = (sep === -1 ? raw : raw.slice(sep + 3)).trim();
  if (!candidate) return "";
  if (/^(error|failed|invalid|warning|status)\b/i.test(candidate)) {
    return "";
  }
  if (!/^[a-z_][a-z0-9_]*\s*:/m.test(candidate)) {
    return "";
  }
  try {
    const parsed = YAML.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "";
    }
  } catch {
    return "";
  }
  return candidate;
}

const shellQuote = (value: string): string => `'${String(value).replace(/'/g, `'\\''`)}'`;

function validateSandboxName(name: string, label = "sandbox name"): string {
  if (!name || typeof name !== "string") {
    throw new Error(`${label} is required`);
  }
  if (name.length > 63) {
    throw new Error(`${label} too long (max 63 chars): '${name.slice(0, 20)}...'`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid ${label}: '${name}'. Must be lowercase alphanumeric with optional internal hyphens.`,
    );
  }
  return name;
}

function normalizePolicyYaml(currentPolicy = ""): string {
  const parsed = parseCurrentPolicyDocument(currentPolicy);
  if (parsed) return parsed;
  return "version: 1\nnetwork_policies: {}\n";
}

export function validateHostBridgeName(name: string): string {
  if (name !== SUPPORTED_HOST_BRIDGE) {
    throw new Error(
      `Unsupported host bridge '${name}'. Supported bridges: ${SUPPORTED_HOST_BRIDGE}`,
    );
  }
  return name;
}

export function buildCodexVersionBridgeRegistration(
  sandboxName: string,
  { includeBinary = true }: { includeBinary?: boolean } = {},
): HostBridgeRegistration {
  validateSandboxName(sandboxName, "sandbox name");
  const registration: HostBridgeRegistration = {
    version: 1,
    sandbox: sandboxName,
    service_name: CODEX_VERSION_SERVICE_NAME,
    service_port: CODEX_VERSION_SERVICE_PORT,
    target_scheme: CODEX_VERSION_TARGET_SCHEME,
    target_host: CODEX_VERSION_TARGET_HOST,
    target_port: CODEX_VERSION_TARGET_PORT,
    target_path: CODEX_VERSION_TARGET_PATH,
    protocol: "rest",
    enforcement: "enforce",
    rules: baseRules(),
  };
  if (includeBinary) {
    registration.binaries = [{ path: CODEX_VERSION_BINARY }];
  }
  return registration;
}

export function buildCodexVersionPolicyEntry(
  { includeBinary = true }: { includeBinary?: boolean } = {},
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: CODEX_VERSION_POLICY_NAME,
    endpoints: [
      {
        host: CODEX_VERSION_SERVICE_NAME,
        port: CODEX_VERSION_SERVICE_PORT,
        protocol: "rest",
        enforcement: "enforce",
        rules: baseRules(),
      },
    ],
  };
  if (includeBinary) {
    entry.binaries = [{ path: CODEX_VERSION_BINARY }];
  }
  return entry;
}

export function policyHasCodexVersionBridge(currentPolicy = ""): boolean {
  const parsed = YAML.parse(normalizePolicyYaml(currentPolicy)) as Record<string, unknown>;
  const networkPolicies = parsed?.network_policies;
  if (!networkPolicies || typeof networkPolicies !== "object" || Array.isArray(networkPolicies)) {
    return false;
  }
  return Boolean((networkPolicies as Record<string, unknown>)[CODEX_VERSION_POLICY_NAME]);
}

export function mergeCodexVersionPolicy(
  currentPolicy = "",
  { includeBinary = true }: { includeBinary?: boolean } = {},
): string {
  const parsed = YAML.parse(normalizePolicyYaml(currentPolicy)) as Record<string, unknown>;
  const next = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  next.version = Number.isInteger(next.version) ? next.version : 1;
  const networkPolicies =
    next.network_policies &&
    typeof next.network_policies === "object" &&
    !Array.isArray(next.network_policies)
      ? { ...(next.network_policies as Record<string, unknown>) }
      : {};
  networkPolicies[CODEX_VERSION_POLICY_NAME] = buildCodexVersionPolicyEntry({ includeBinary });
  next.network_policies = networkPolicies;
  return YAML.stringify(next);
}

export function removeCodexVersionPolicy(currentPolicy = ""): string {
  const parsed = YAML.parse(normalizePolicyYaml(currentPolicy)) as Record<string, unknown>;
  const next = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  next.version = Number.isInteger(next.version) ? next.version : 1;
  const networkPolicies =
    next.network_policies &&
    typeof next.network_policies === "object" &&
    !Array.isArray(next.network_policies)
      ? { ...(next.network_policies as Record<string, unknown>) }
      : {};
  delete networkPolicies[CODEX_VERSION_POLICY_NAME];
  next.network_policies = networkPolicies;
  return YAML.stringify(next);
}

export function buildHostServiceRegisterArgs(
  sandboxName: string,
  registrationPath: string,
): string[] {
  validateSandboxName(sandboxName, "sandbox name");
  return ["host-service", "register", "--sandbox", sandboxName, "--file", registrationPath, "--wait"];
}

export function buildHostServiceUnregisterArgs(sandboxName: string): string[] {
  validateSandboxName(sandboxName, "sandbox name");
  return [
    "host-service",
    "unregister",
    "--sandbox",
    sandboxName,
    "--service-name",
    CODEX_VERSION_SERVICE_NAME,
    "--service-port",
    String(CODEX_VERSION_SERVICE_PORT),
    "--wait",
  ];
}

export function buildHostServiceListArgs(sandboxName: string): string[] {
  validateSandboxName(sandboxName, "sandbox name");
  return ["host-service", "list", "--sandbox", sandboxName];
}

export function buildPolicySetArgs(sandboxName: string, policyPath: string): string[] {
  validateSandboxName(sandboxName, "sandbox name");
  return ["policy", "set", "--policy", policyPath, "--wait", sandboxName];
}

export function buildHostBridgeEvidencePaths(
  sandboxName: string,
  operation: HostBridgeOperation,
  now = new Date(),
): HostBridgeEvidencePaths {
  validateSandboxName(sandboxName, "sandbox name");
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dir = path.join(
    getHostBridgeStateDir(),
    sandboxName,
    `${stamp}-${operation}-${SUPPORTED_HOST_BRIDGE}`,
  );
  return {
    dir,
    policyBeforePath: path.join(dir, "policy_before.yaml"),
    policyAfterPath: path.join(dir, "policy_after.yaml"),
    registrationPath: path.join(dir, "bridge_registration.json"),
    revertScriptPath: path.join(dir, "revert.sh"),
    validationNotesPath: path.join(dir, "validation_notes.txt"),
  };
}

export function buildHostBridgeRevertScript(params: {
  operation: HostBridgeOperation;
  sandboxName: string;
  policyBeforePath: string;
  registrationPath: string;
}): string {
  const sandboxName = validateSandboxName(params.sandboxName, "sandbox name");
  const lines = ["#!/usr/bin/env bash", "set -euo pipefail"];
  if (params.operation === "add") {
    lines.push(`openshell ${buildHostServiceUnregisterArgs(sandboxName).map(shellQuote).join(" ")} || true`);
  } else {
    lines.push(
      `openshell ${buildHostServiceRegisterArgs(sandboxName, params.registrationPath)
        .map(shellQuote)
        .join(" ")}`,
    );
  }
  lines.push(`openshell ${buildPolicySetArgs(sandboxName, params.policyBeforePath).map(shellQuote).join(" ")}`);
  return lines.join("\n") + "\n";
}

export function formatHostBridgeValidationNotes(params: {
  operation: HostBridgeOperation;
  sandboxName: string;
  result: "pending" | "success" | "failed";
  details: string[];
}): string {
  const lines = [
    `host_bridge=${SUPPORTED_HOST_BRIDGE}`,
    `operation=${params.operation}`,
    `sandbox=${params.sandboxName}`,
    `service_name=${CODEX_VERSION_SERVICE_NAME}`,
    `service_port=${CODEX_VERSION_SERVICE_PORT}`,
    `target=${CODEX_VERSION_TARGET_SCHEME}://${CODEX_VERSION_TARGET_HOST}:${CODEX_VERSION_TARGET_PORT}${CODEX_VERSION_TARGET_PATH}`,
    `result=${params.result}`,
    "notes:",
    ...params.details.map((detail) => `- ${detail}`),
  ];
  return lines.join("\n") + "\n";
}

export function writeHostBridgeEvidence(params: {
  paths: HostBridgeEvidencePaths;
  policyBefore: string;
  policyAfter: string;
  registration: HostBridgeRegistration;
  revertScript: string;
  validationNotes: string;
}): void {
  ensureConfigDir(params.paths.dir);
  fs.writeFileSync(params.paths.policyBeforePath, params.policyBefore, { encoding: "utf-8", mode: 0o600 });
  fs.writeFileSync(params.paths.policyAfterPath, params.policyAfter, { encoding: "utf-8", mode: 0o600 });
  fs.writeFileSync(params.paths.registrationPath, JSON.stringify(params.registration, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.writeFileSync(params.paths.revertScriptPath, params.revertScript, {
    encoding: "utf-8",
    mode: 0o700,
  });
  fs.writeFileSync(params.paths.validationNotesPath, params.validationNotes, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function updateHostBridgeValidationNotes(
  validationNotesPath: string,
  validationNotes: string,
): void {
  fs.writeFileSync(validationNotesPath, validationNotes, { encoding: "utf-8", mode: 0o600 });
}

export function listHostBridgeEvidenceDirs(sandboxName: string): string[] {
  validateSandboxName(sandboxName, "sandbox name");
  const sandboxDir = path.join(getHostBridgeStateDir(), sandboxName);
  if (!fs.existsSync(sandboxDir)) return [];
  return fs
    .readdirSync(sandboxDir)
    .map((entry) => path.join(sandboxDir, entry))
    .filter((entry) => fs.statSync(entry).isDirectory())
    .sort()
    .reverse();
}
