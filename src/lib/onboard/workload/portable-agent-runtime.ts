// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { AgentDefinition } from "../../agent/definition-types";

export const PORTABLE_AGENT_RUNTIME_CONTRACT_VERSION = 1 as const;
export const PORTABLE_AGENT_RUNTIME_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const PORTABLE_AGENT_RUNTIME_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

export type PortableAgentRuntimePlatform = (typeof PORTABLE_AGENT_RUNTIME_PLATFORMS)[number];
export type PortableAgentImageDigest = `sha256:${string}`;
export type PortableAgentImageReference = `${string}@${PortableAgentImageDigest}`;

export interface PortableAgentRuntimeProviderSupport {
  readonly exactDigestReferences: boolean;
  readonly agents: readonly string[];
  readonly platforms: readonly PortableAgentRuntimePlatform[];
  readonly contractVersions: readonly number[];
  readonly capabilityContractVersions: readonly number[];
  readonly tokenizedStartupCommands: boolean;
  readonly openshellSandboxCommand: boolean;
  readonly runtimeSelectedNonRootIdentity: boolean;
  readonly openshellWorkspaceOwnership: boolean;
  readonly ownerOnlyPrivateState: boolean;
}

/**
 * Credential-free image declaration combined with repository-owned agent semantics.
 * Workload selection must check the selected provider profile before admitting it.
 */
export interface PortableAgentRuntimeContractV1 {
  readonly contractVersion: typeof PORTABLE_AGENT_RUNTIME_CONTRACT_VERSION;
  readonly capabilityContractVersion: typeof PORTABLE_AGENT_RUNTIME_CAPABILITY_CONTRACT_VERSION;
  readonly agent: string;
  readonly agentVersion: string;
  readonly agentDefinitionSha256: string;
  readonly platform: PortableAgentRuntimePlatform;
  readonly image: {
    readonly repository: string;
    readonly digest: PortableAgentImageDigest;
    readonly reference: PortableAgentImageReference;
  };
  readonly startup: {
    readonly authority: "image-contract";
    readonly argv: readonly string[];
    readonly workingDirectory: string;
  };
  readonly filesystem: {
    readonly homeDirectory: string;
    readonly configDirectory: string;
    readonly workspaceOwnership: "openshell";
    readonly privateState: "owner-only";
  };
  readonly runtimeIdentity: "non-root";
  /** Environment-variable names only. Credential values never enter this contract. */
  readonly credentialEnvironmentNames: readonly string[];
  readonly health: {
    readonly url: string;
    readonly port: number;
    readonly timeoutSeconds: number;
  };
}

const AGENT_PATTERN = /^[a-z][a-z0-9-]{0,127}$/u;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){2,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const OCI_REPOSITORY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const COMMAND_TOKEN_PATTERN = /^[^\s"'\\`$;&|<>()[\]{}]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_CONTRACT_BYTES = 64 * 1024;
const MAX_CONTRACT_NODES = 512;
const MAX_CONTRACT_DEPTH = 12;
const MAX_PATTERN_BYTES = 256;
const MAX_PATH_BYTES = 4096;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_ARGUMENTS = 64;
const MAX_ENVIRONMENT_NAMES = 32;

export class PortableAgentRuntimeContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid portable agent runtime contract: ${message}`, options);
    this.name = "PortableAgentRuntimeContractError";
  }
}

function fail(message: string): never {
  throw new PortableAgentRuntimeContractError(message);
}

function assertPlainBoundedJson(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_CONTRACT_NODES || current.depth > MAX_CONTRACT_DEPTH) {
      fail("structure exceeds the complexity limit");
    }
    if (typeof current.value === "string") {
      bytes += Buffer.byteLength(current.value, "utf8");
      if (bytes > MAX_CONTRACT_BYTES) fail("payload exceeds the byte limit");
      continue;
    }
    if (Array.isArray(current.value)) {
      if (
        Object.getPrototypeOf(current.value) !== Array.prototype ||
        "toJSON" in current.value ||
        Object.getOwnPropertySymbols(current.value).length > 0 ||
        Object.getOwnPropertyNames(current.value).length !== current.value.length + 1
      ) {
        fail("payload must contain only plain JSON arrays");
      }
      for (let index = 0; index < current.value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          fail("payload must contain only JSON data properties");
        }
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value !== null && typeof current.value === "object") {
      const prototype = Object.getPrototypeOf(current.value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        "toJSON" in current.value ||
        Object.getOwnPropertySymbols(current.value).length > 0
      ) {
        fail("payload must contain only plain JSON objects");
      }
      for (const key of Object.getOwnPropertyNames(current.value)) {
        bytes += Buffer.byteLength(key, "utf8");
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || !("value" in descriptor)) {
          fail("payload must contain only JSON data properties");
        }
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      if (bytes > MAX_CONTRACT_BYTES) fail("payload exceeds the byte limit");
      continue;
    }
    if (
      current.value !== null &&
      typeof current.value !== "number" &&
      typeof current.value !== "boolean"
    ) {
      fail("payload must contain only JSON values");
    }
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${field} must contain exactly: ${expected.join(", ")}`);
  }
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) fail(`${field} must be ${JSON.stringify(expected)}`);
  return expected;
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PATTERN_BYTES ||
    !pattern.test(value)
  ) {
    fail(`${field} has an unsupported format`);
  }
  return value;
}

function requirePortableAbsolutePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value === "/" ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    value.includes("\\") ||
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    fail(`${field} must be a canonical absolute POSIX path below root`);
  }
  return value;
}

function isWithinDirectory(parent: string, candidate: string, allowSame: boolean): boolean {
  const relative = path.posix.relative(parent, candidate);
  if (relative === "") return allowSame;
  return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
}

function requireStringArray(
  value: unknown,
  field: string,
  maxEntries: number,
  pattern?: RegExp,
  allowEmpty = false,
): readonly string[] {
  const minimumEntries = allowEmpty ? 0 : 1;
  if (!Array.isArray(value) || value.length < minimumEntries || value.length > maxEntries) {
    fail(
      `${field} must contain between ${String(minimumEntries)} and ${String(maxEntries)} strings`,
    );
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      Buffer.byteLength(entry, "utf8") > MAX_ARGUMENT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(entry) ||
      (pattern !== undefined && !pattern.test(entry))
    ) {
      fail(`${field}[${String(index)}] has an unsupported format`);
    }
    return entry;
  });
}

function portableGatewayArgv(agent: AgentDefinition): readonly string[] {
  const command = agent.gateway_command?.trim() ?? "";
  if (!command) fail("agent definition does not declare a gateway command");
  const argv = command.split(/\s+/u);
  if (argv.length > MAX_ARGUMENTS || argv.some((token) => !COMMAND_TOKEN_PATTERN.test(token))) {
    fail("agent definition gateway command is not a portable tokenized command");
  }
  return argv;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return result;
}

/** Bind image compatibility to agent-owned command, health, config, and state semantics. */
export function portableAgentDefinitionSha256(agent: AgentDefinition): string {
  const health = agent.healthProbe;
  const version = agent.expectedVersion;
  if (!health || !version) fail("agent definition is missing version or health authority");
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          agent: agent.name,
          version,
          startupArgv: portableGatewayArgv(agent),
          runtime: agent.runtime,
          health,
          config: {
            configFile: agent.configPaths.configFile,
            envFile: agent.configPaths.envFile,
            format: agent.configPaths.format,
          },
          stateDirectories: agent.stateDirectories,
          stateFiles: agent.stateFiles,
          userManagedFiles: agent.userManagedFiles,
          webAuth: agent.webAuth,
          devicePairing: agent.hasDevicePairing,
        }),
      ),
      "utf8",
    )
    .digest("hex");
}

function requireHealth(
  value: unknown,
  agent: AgentDefinition,
): PortableAgentRuntimeContractV1["health"] {
  const health = requireRecord(value, "contract.health");
  requireExactKeys(health, ["port", "timeoutSeconds", "url"], "contract.health");
  const expected = agent.healthProbe;
  if (!expected) fail("agent definition is missing health authority");
  const url = requirePattern(health.url, /^https?:\/\/[^\s]+$/u, "contract.health.url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail("contract.health.url has an unsupported format");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    fail("contract.health.url must be a credential-free loopback URL");
  }
  const port = health.port;
  const timeoutSeconds = health.timeoutSeconds;
  if (
    !Number.isInteger(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535 ||
    !Number.isInteger(timeoutSeconds) ||
    Number(timeoutSeconds) < 1 ||
    Number(timeoutSeconds) > 600
  ) {
    fail("contract.health has an unsupported port or timeout");
  }
  const normalized = { url, port: Number(port), timeoutSeconds: Number(timeoutSeconds) };
  const expectedHealth = {
    url: expected.url,
    port: expected.port,
    timeoutSeconds: expected.timeout_seconds,
  };
  if (!isDeepStrictEqual(normalized, expectedHealth)) {
    fail("contract.health does not match the agent definition");
  }
  return normalized;
}

function expectedCredentialEnvironmentNames(agent: AgentDefinition): readonly string[] {
  return agent.webAuth.method === "bearer_token" && agent.webAuth.env ? [agent.webAuth.env] : [];
}

export function parsePortableAgentRuntimeContractV1(
  value: unknown,
  expectedAgent: AgentDefinition,
): PortableAgentRuntimeContractV1 {
  assertPlainBoundedJson(value);
  const contract = requireRecord(value, "contract");
  requireExactKeys(
    contract,
    [
      "agent",
      "agentDefinitionSha256",
      "agentVersion",
      "capabilityContractVersion",
      "contractVersion",
      "credentialEnvironmentNames",
      "filesystem",
      "health",
      "image",
      "platform",
      "runtimeIdentity",
      "startup",
    ],
    "contract",
  );
  const contractVersion = requireLiteral(
    contract.contractVersion,
    PORTABLE_AGENT_RUNTIME_CONTRACT_VERSION,
    "contract.contractVersion",
  );
  const capabilityContractVersion = requireLiteral(
    contract.capabilityContractVersion,
    PORTABLE_AGENT_RUNTIME_CAPABILITY_CONTRACT_VERSION,
    "contract.capabilityContractVersion",
  );
  const agent = requirePattern(contract.agent, AGENT_PATTERN, "contract.agent");
  if (agent !== expectedAgent.name) fail("contract.agent does not match the selected agent");
  const agentVersion = requirePattern(
    contract.agentVersion,
    VERSION_PATTERN,
    "contract.agentVersion",
  );
  if (agentVersion !== expectedAgent.expectedVersion) {
    fail("contract.agentVersion does not match the selected agent");
  }
  const agentDefinitionSha256 = requirePattern(
    contract.agentDefinitionSha256,
    SHA256_PATTERN,
    "contract.agentDefinitionSha256",
  );
  if (agentDefinitionSha256 !== portableAgentDefinitionSha256(expectedAgent)) {
    fail("contract.agentDefinitionSha256 does not match the selected agent");
  }
  if (
    typeof contract.platform !== "string" ||
    !(PORTABLE_AGENT_RUNTIME_PLATFORMS as readonly string[]).includes(contract.platform)
  ) {
    fail(`contract.platform must be one of: ${PORTABLE_AGENT_RUNTIME_PLATFORMS.join(", ")}`);
  }
  const platform = contract.platform as PortableAgentRuntimePlatform;

  const image = requireRecord(contract.image, "contract.image");
  requireExactKeys(image, ["digest", "reference", "repository"], "contract.image");
  const repository = requirePattern(
    image.repository,
    OCI_REPOSITORY_PATTERN,
    "contract.image.repository",
  );
  const digest = requirePattern(image.digest, DIGEST_PATTERN, "contract.image.digest");
  const reference = requireLiteral(
    image.reference,
    `${repository}@${digest}`,
    "contract.image.reference",
  );
  const startup = requireRecord(contract.startup, "contract.startup");
  requireExactKeys(startup, ["argv", "authority", "workingDirectory"], "contract.startup");
  const authority = requireLiteral(
    startup.authority,
    "image-contract",
    "contract.startup.authority",
  );
  const argv = requireStringArray(startup.argv, "contract.startup.argv", MAX_ARGUMENTS);
  if (!isDeepStrictEqual(argv, portableGatewayArgv(expectedAgent))) {
    fail("contract.startup.argv does not match the agent definition");
  }
  const workingDirectory = requirePortableAbsolutePath(
    startup.workingDirectory,
    "contract.startup.workingDirectory",
  );

  const filesystem = requireRecord(contract.filesystem, "contract.filesystem");
  requireExactKeys(
    filesystem,
    ["configDirectory", "homeDirectory", "privateState", "workspaceOwnership"],
    "contract.filesystem",
  );
  const homeDirectory = requirePortableAbsolutePath(
    filesystem.homeDirectory,
    "contract.filesystem.homeDirectory",
  );
  const configDirectory = requirePortableAbsolutePath(
    filesystem.configDirectory,
    "contract.filesystem.configDirectory",
  );
  if (!isWithinDirectory(homeDirectory, workingDirectory, true)) {
    fail("contract.startup.workingDirectory must be within the declared home directory");
  }
  if (!isWithinDirectory(homeDirectory, configDirectory, false)) {
    fail("contract.filesystem.configDirectory must be below the declared home directory");
  }
  if (configDirectory !== expectedAgent.configPaths.dir) {
    fail("contract.filesystem.configDirectory does not match the agent definition");
  }
  const workspaceOwnership = requireLiteral(
    filesystem.workspaceOwnership,
    "openshell",
    "contract.filesystem.workspaceOwnership",
  );
  const privateState = requireLiteral(
    filesystem.privateState,
    "owner-only",
    "contract.filesystem.privateState",
  );
  const runtimeIdentity = requireLiteral(
    contract.runtimeIdentity,
    "non-root",
    "contract.runtimeIdentity",
  );

  const credentialEnvironmentNames = requireStringArray(
    contract.credentialEnvironmentNames,
    "contract.credentialEnvironmentNames",
    MAX_ENVIRONMENT_NAMES,
    ENVIRONMENT_NAME_PATTERN,
    true,
  );
  if (
    new Set(credentialEnvironmentNames).size !== credentialEnvironmentNames.length ||
    !isDeepStrictEqual(
      credentialEnvironmentNames,
      expectedCredentialEnvironmentNames(expectedAgent),
    )
  ) {
    fail("contract.credentialEnvironmentNames do not match the agent definition");
  }
  const health = requireHealth(contract.health, expectedAgent);

  return {
    contractVersion,
    capabilityContractVersion,
    agent,
    agentVersion,
    agentDefinitionSha256,
    platform,
    image: {
      repository,
      digest: digest as PortableAgentImageDigest,
      reference: reference as PortableAgentImageReference,
    },
    startup: { authority, argv, workingDirectory },
    filesystem: { homeDirectory, configDirectory, workspaceOwnership, privateState },
    runtimeIdentity,
    credentialEnvironmentNames,
    health,
  };
}

export function portableAgentRuntimeSupportError(
  support: PortableAgentRuntimeProviderSupport | null,
  contract: PortableAgentRuntimeContractV1,
): string | null {
  if (support === null) return "the runtime provider does not advertise portable agent runtimes";
  if (!support.exactDigestReferences) {
    return "the runtime provider does not enforce exact-digest image references";
  }
  if (!support.agents.includes(contract.agent)) {
    return "the runtime provider does not qualify the selected agent";
  }
  if (!support.platforms.includes(contract.platform)) {
    return "the runtime provider does not qualify the selected platform";
  }
  if (!support.contractVersions.includes(contract.contractVersion)) {
    return "the runtime provider does not support the portable contract version";
  }
  if (!support.capabilityContractVersions.includes(contract.capabilityContractVersion)) {
    return "the runtime provider does not support the portable capability version";
  }
  if (!support.tokenizedStartupCommands) {
    return "the runtime provider does not preserve tokenized startup commands";
  }
  if (!support.openshellSandboxCommand) {
    return "the runtime provider does not provide the supported OpenShell sandbox command";
  }
  if (!support.runtimeSelectedNonRootIdentity) {
    return "the runtime provider does not provide runtime-selected non-root identity";
  }
  if (!support.openshellWorkspaceOwnership) {
    return "the runtime provider does not provide OpenShell workspace ownership";
  }
  if (!support.ownerOnlyPrivateState) {
    return "the runtime provider does not preserve owner-only private state";
  }
  return null;
}
