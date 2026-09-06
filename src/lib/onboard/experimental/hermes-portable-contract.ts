// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import type { AgentDefinition, ManifestRecord } from "../../agent/definition-types";
import {
  parseManifestRecord,
  readBoolean,
  readHealthProbe,
  readObject,
  readStateFiles,
  readString,
  readUserManagedFiles,
} from "../../agent/manifest-readers";
import { readAgentRuntime } from "../../agent/runtime-manifest";
import { readStateDirectories } from "../../agent/state-directory-contract";
import { readWebAuth } from "../../agent/web-auth";
import {
  buildCurrentHermesPortableRuntimeEnvArgs,
  currentHermesPortableAgentDefinition,
} from "../docker-startup-command-env";
import type { HermesPortableStartupContract } from "./hermes-portable-receipt";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const MAX_MANIFEST_BYTES = 128 * 1024;
const STARTUP_EXECUTABLE = "/usr/local/bin/nemoclaw-start";
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const PORT = /^(?:[1-9][0-9]{0,4})$/u;
const PLACEHOLDER_KEYS = /^[A-Z_][A-Z0-9_]*(?:,[A-Z_][A-Z0-9_]*)*$/u;
const SHELL_PAYLOAD = /(?:[`;|]|&&|\$\()/u;
const ALLOWED_ENV = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NEMOCLAW_HERMES_API_PORT",
  "NEMOCLAW_PROXY_HOST",
  "NEMOCLAW_PROXY_PORT",
  "NEMOCLAW_SANDBOX_NAME",
  "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS",
]);

export interface ResolveHermesPortableStartupContractInput {
  readonly agent: AgentDefinition;
  readonly startupArgv: readonly string[];
  readonly sandboxName: string;
}

function fail(message: string): never {
  throw new Error(`Hermes portable startup contract ${message}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return result;
}

function readExactManifestPath(manifestPath: string): Buffer {
  const parentPath = path.dirname(manifestPath);
  const parentBefore = fs.lstatSync(parentPath, { bigint: true });
  const descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(manifestPath, { bigint: true });
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !before.isFile() ||
      named.isSymbolicLink() ||
      before.nlink !== 1n ||
      (before.uid !== 0n && before.uid !== BigInt(uid)) ||
      (before.mode & 0o22n) !== 0n ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      !parentBefore.isDirectory() ||
      parentBefore.isSymbolicLink() ||
      (parentBefore.uid !== 0n && parentBefore.uid !== BigInt(uid)) ||
      (parentBefore.mode & 0o22n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(MAX_MANIFEST_BYTES)
    ) {
      fail("manifest source is unsafe");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) fail("manifest ended during read");
      offset += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalNamed = fs.lstatSync(manifestPath, { bigint: true });
    const parentAfter = fs.lstatSync(parentPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      finalNamed.dev !== after.dev ||
      finalNamed.ino !== after.ino ||
      parentBefore.dev !== parentAfter.dev ||
      parentBefore.ino !== parentAfter.ino ||
      parentBefore.mode !== parentAfter.mode ||
      parentBefore.uid !== parentAfter.uid ||
      parentBefore.mtimeNs !== parentAfter.mtimeNs ||
      parentBefore.ctimeNs !== parentAfter.ctimeNs
    ) {
      fail("manifest changed during read");
    }
    try {
      UTF8.decode(bytes);
    } catch {
      fail("manifest is not strict UTF-8");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readExactManifest(agent: AgentDefinition): Buffer {
  return readExactManifestPath(agent.manifestPath);
}

function manifestConfigPaths(config: ManifestRecord | undefined) {
  return {
    dir: readString(config ?? {}, "dir") ?? "/sandbox/.openclaw",
    configFile: readString(config ?? {}, "config_file") ?? "openclaw.json",
    envFile: readString(config ?? {}, "env_file") ?? null,
    format: readString(config ?? {}, "format") ?? "json",
  };
}

function manifestProjection(record: ManifestRecord) {
  const config = readObject(record, "config");
  const stateDirectories = readStateDirectories(record);
  return {
    name: readString(record, "name"),
    expectedVersion: readString(record, "expected_version"),
    gatewayCommand: readString(record, "gateway_command"),
    runtime: readAgentRuntime(record),
    healthProbe: readHealthProbe(record) ?? null,
    devicePairing: readBoolean(record, "device_pairing"),
    webAuth: readWebAuth(record),
    configPaths: manifestConfigPaths(config),
    stateDirectories,
    stateFiles: readStateFiles(record) ?? [],
    userManagedFiles: readUserManagedFiles(record) ?? [],
  };
}

function agentProjection(agent: AgentDefinition): ReturnType<typeof manifestProjection> {
  return {
    name: agent.name,
    expectedVersion: agent.expected_version,
    gatewayCommand: agent.gateway_command,
    runtime: agent.runtime ?? { kind: "gateway" },
    healthProbe: agent.healthProbe,
    devicePairing: agent.device_pairing,
    webAuth: agent.webAuth,
    configPaths: agent.configPaths,
    stateDirectories: agent.stateDirectories,
    stateFiles: agent.stateFiles,
    userManagedFiles: agent.userManagedFiles,
  };
}

function parseExactManifest(bytes: Buffer): ReturnType<typeof manifestProjection> {
  let record: ManifestRecord;
  try {
    record = parseManifestRecord(UTF8.decode(bytes), "Hermes portable manifest");
    return manifestProjection(record);
  } catch {
    fail("manifest is invalid");
  }
}

function validateUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is not a URL`);
  }
  if (parsed.username || parsed.password) fail(`${label} contains credentials`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`${label} uses an unsupported URL scheme`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail(`${label} contains a path, query, or fragment that cannot enter durable authority`);
  }
}

function validateAssignment(key: string, value: string, sandboxName: string): void {
  if (!ENV_NAME.test(key) || !ALLOWED_ENV.has(key)) fail(`argv contains unsupported env '${key}'`);
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`argv env '${key}' has an invalid value`);
  }
  if (SHELL_PAYLOAD.test(value)) fail(`argv env '${key}' contains a shell payload`);
  if (key === "NEMOCLAW_SANDBOX_NAME" && value !== sandboxName) {
    fail("argv sandbox identity changed");
  }
  if (key === "NEMOCLAW_HERMES_API_PORT" && value !== "8642") {
    fail("argv Hermes API port changed");
  }
  if (key.endsWith("_PORT") && !PORT.test(value)) fail(`argv env '${key}' is not a port`);
  if (key === "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS" && !PLACEHOLDER_KEYS.test(value)) {
    fail("argv placeholder names are invalid");
  }
  if (
    key === "HTTP_PROXY" ||
    key === "HTTPS_PROXY" ||
    key === "http_proxy" ||
    key === "https_proxy"
  ) {
    validateUrl(value, `argv env '${key}'`);
  }
}

function validateStartupArgv(argv: readonly string[], sandboxName: string): readonly string[] {
  if (
    argv.length < 4 ||
    argv.length > 64 ||
    argv[0] !== "env" ||
    argv.at(-1) !== STARTUP_EXECUTABLE
  ) {
    fail("argv does not match the managed Hermes startup form");
  }
  const seen = new Set<string>();
  for (const assignment of argv.slice(1, -1)) {
    const separator = assignment.indexOf("=");
    if (separator < 1) fail("argv contains a non-assignment before startup");
    const key = assignment.slice(0, separator);
    const value = assignment.slice(separator + 1);
    if (seen.has(key)) fail(`argv contains duplicate env '${key}'`);
    seen.add(key);
    validateAssignment(key, value, sandboxName);
  }
  if (!seen.has("NEMOCLAW_SANDBOX_NAME") || !seen.has("NEMOCLAW_HERMES_API_PORT")) {
    fail("argv is missing the sandbox name or Hermes API port");
  }
  return [...argv];
}

function startupAssignments(argv: readonly string[]): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const assignment of argv.slice(1, -1)) {
    const separator = assignment.indexOf("=");
    assignments.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }
  return assignments;
}

function requiredAssignment(assignments: ReadonlyMap<string, string>, name: string): string {
  const value = assignments.get(name);
  if (!value) fail(`stored argv is missing renderer input '${name}'`);
  return value;
}

function rerenderCurrentStartupArgv(
  storedArgv: readonly string[],
  sandboxName: string,
): readonly string[] {
  const argv = validateStartupArgv(storedArgv, sandboxName);
  const assignments = startupAssignments(argv);
  const environment = Object.fromEntries(assignments);
  const extraPlaceholderKeys = (assignments.get("NEMOCLAW_EXTRA_PLACEHOLDER_KEYS") ?? "")
    .split(",")
    .filter(Boolean);
  const rendered = buildCurrentHermesPortableRuntimeEnvArgs({
    chatUiUrl: "http://127.0.0.1:8642/",
    manageDashboard: false,
    getDashboardForwardPort: () => "0",
    hermesDashboardState: { enabled: false, config: null },
    hermesApiPort: Number(requiredAssignment(assignments, "NEMOCLAW_HERMES_API_PORT")),
    extraPlaceholderKeys,
    sandboxName,
    env: environment,
  });
  return ["env", ...rendered.envArgs, STARTUP_EXECUTABLE];
}

function stateIdentity(projection: ReturnType<typeof manifestProjection>): string {
  return sha256(
    JSON.stringify(
      canonical({
        configPaths: projection.configPaths,
        stateDirectories: projection.stateDirectories,
        stateFiles: projection.stateFiles,
        userManagedFiles: projection.userManagedFiles,
      }),
    ),
  );
}

/** Derive the complete lifecycle descriptor from current manifest and launch inputs. */
export function resolveHermesPortableStartupContract(
  input: ResolveHermesPortableStartupContractInput,
): HermesPortableStartupContract {
  const { agent, sandboxName } = input;
  const manifestBytes = readExactManifest(agent);
  const manifest = parseExactManifest(manifestBytes);
  if (!isDeepStrictEqual(manifest, agentProjection(agent))) {
    fail("loaded Hermes manifest disagrees with its exact source");
  }
  if (
    manifest.name !== "hermes" ||
    manifest.expectedVersion !== "0.20.6" ||
    manifest.gatewayCommand !== "hermes gateway run" ||
    manifest.runtime.interactive_command !== "hermes" ||
    manifest.healthProbe?.url !== "http://localhost:8642/health" ||
    manifest.healthProbe.port !== 8642 ||
    manifest.devicePairing !== false ||
    manifest.webAuth.method !== "bearer_token" ||
    manifest.webAuth.env !== "API_SERVER_KEY" ||
    manifest.configPaths.dir !== "/sandbox/.hermes"
  ) {
    fail("current Hermes manifest does not match the accepted lifecycle contract");
  }
  const argv = validateStartupArgv(input.startupArgv, sandboxName);
  const stateIdentitySha256 = stateIdentity(manifest);
  return {
    manifestSha256: sha256(manifestBytes),
    startupDescriptorSha256: sha256(
      JSON.stringify(
        canonical({
          argv,
          configDir: manifest.configPaths.dir,
          devicePairing: manifest.devicePairing,
          gatewayCommand: manifest.gatewayCommand,
          health: manifest.healthProbe,
          interactiveCommand: manifest.runtime.interactive_command,
          stateIdentitySha256,
          webAuth: manifest.webAuth,
        }),
      ),
    ),
    argv,
    gatewayCommand: "hermes gateway run",
    interactiveCommand: "hermes",
    health: {
      url: "http://localhost:8642/health",
      port: 8642,
      method: "GET",
      auth: "bearer_token",
      credentialEnv: "API_SERVER_KEY",
      successStatus: 200,
    },
    devicePairing: false,
    configDir: "/sandbox/.hermes",
    stateIdentitySha256,
  };
}

/** Recheck the complete stored startup descriptor and its current manifest source. */
export function assertCurrentHermesPortableStoredStartupContract(
  actual: HermesPortableStartupContract,
  sandboxName: string,
): void {
  const currentArgv = rerenderCurrentStartupArgv(actual.argv, sandboxName);
  const current = resolveHermesPortableStartupContract({
    agent: currentHermesPortableAgentDefinition(),
    sandboxName,
    startupArgv: currentArgv,
  });
  if (!isDeepStrictEqual(current, actual)) fail("current startup authority disagrees");
}

/** Re-render from current manifest, profile, and launch inputs before lifecycle mutation. */
export function assertCurrentHermesPortableStartupContract(
  expected: HermesPortableStartupContract,
  input: ResolveHermesPortableStartupContractInput,
): HermesPortableStartupContract {
  const current = resolveHermesPortableStartupContract(input);
  if (!isDeepStrictEqual(current, expected)) fail("current startup authority disagrees");
  return current;
}
