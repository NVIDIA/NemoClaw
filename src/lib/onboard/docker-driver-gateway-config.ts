// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type DockerDriverGatewayJwtBundle,
  ensureDockerDriverGatewayJwtBundle,
} from "./docker-driver-gateway-jwt-bundle";

export type { DockerDriverGatewayJwtBundle } from "./docker-driver-gateway-jwt-bundle";
export { ensureDockerDriverGatewayJwtBundle } from "./docker-driver-gateway-jwt-bundle";

// See docs/security/openshell-0.0.72-compatibility-review.mdx for the source-of-truth review.
export const DOCKER_DRIVER_GATEWAY_CONFIG_NAME = "openshell-gateway.toml";
export const MANAGED_GATEWAY_RUNTIME_BINDING_NAME = "managed-runtime.json";
export const DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS = 0;
const MANAGED_GATEWAY_RUNTIME_BINDING_VERSION = 1;
const MANAGED_GATEWAY_RUNTIME_BINDING_MAX_BYTES = 64 * 1024;

type ManagedGatewayRuntimeValue = string | number | boolean;

export interface ManagedGatewayRuntimeBinding {
  readonly version: typeof MANAGED_GATEWAY_RUNTIME_BINDING_VERSION;
  readonly driverName: string;
  readonly configSha256: string;
  readonly values: Readonly<Record<string, ManagedGatewayRuntimeValue>>;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function writeRestrictedFile(filePath: string, value: string, mode = 0o600): void {
  fs.writeFileSync(filePath, value, { encoding: "utf-8", mode });
  fs.chmodSync(filePath, mode);
}

function writeRestrictedFileAtomic(filePath: string, value: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  cleanupStaleAtomicFileTemps(dir, basename);
  const tmpPath = path.join(
    dir,
    `.${basename}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  let committed = false;
  try {
    writeRestrictedFile(tmpPath, value, mode);
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, mode);
    committed = true;
  } finally {
    if (!committed) fs.rmSync(tmpPath, { force: true });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedGatewayRuntimeValues(
  driver: ManagedGatewayDriverConfig,
): Record<string, ManagedGatewayRuntimeValue> {
  const persistedKeys = new Set<string>();
  for (const key of driver.persistedRuntimeKeys) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || persistedKeys.has(key)) {
      throw new Error(`Invalid or duplicate managed gateway persisted runtime key '${key}'.`);
    }
    persistedKeys.add(key);
  }
  const values: Record<string, ManagedGatewayRuntimeValue> = {};
  for (const [key, value] of driver.entries) {
    if (value === undefined || (typeof value === "string" && value.trim() === "")) continue;
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || Object.hasOwn(values, key)) {
      throw new Error(`Invalid or duplicate managed gateway runtime key '${key}'.`);
    }
    if (persistedKeys.has(key)) values[key] = value;
    persistedKeys.delete(key);
  }
  if (persistedKeys.size > 0) {
    throw new Error(
      `Managed gateway persisted runtime key(s) are absent from the driver config: ${[
        ...persistedKeys,
      ].join(", ")}.`,
    );
  }
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function writeManagedGatewayRuntimeBinding(
  stateDir: string,
  driver: ManagedGatewayDriverConfig,
  configText: string,
): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(driver.driverName)) {
    throw new Error(`Invalid managed gateway driver name '${driver.driverName}'.`);
  }
  const binding: ManagedGatewayRuntimeBinding = {
    version: MANAGED_GATEWAY_RUNTIME_BINDING_VERSION,
    driverName: driver.driverName,
    configSha256: sha256(configText),
    values: managedGatewayRuntimeValues(driver),
  };
  writeRestrictedFileAtomic(
    path.join(stateDir, MANAGED_GATEWAY_RUNTIME_BINDING_NAME),
    `${JSON.stringify(binding, null, 2)}\n`,
    0o600,
  );
}

function readRestrictedRuntimeFile(filePath: string): string {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error(
        `Managed gateway runtime file '${filePath}' failed ownership or mode checks.`,
      );
    }
    throw error;
  }
  try {
    const metadata = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      !metadata.isFile() ||
      metadata.uid !== currentUid ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > MANAGED_GATEWAY_RUNTIME_BINDING_MAX_BYTES
    ) {
      throw new Error(
        `Managed gateway runtime file '${filePath}' failed ownership or mode checks.`,
      );
    }
    const value = fs.readFileSync(descriptor, "utf-8");
    if (Buffer.byteLength(value, "utf-8") !== metadata.size) {
      throw new Error(`Managed gateway runtime file '${filePath}' changed while it was read.`);
    }
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readManagedGatewayRuntimeBinding(
  stateDir: string,
): ManagedGatewayRuntimeBinding | null {
  const bindingPath = path.join(stateDir, MANAGED_GATEWAY_RUNTIME_BINDING_NAME);
  let raw: string;
  try {
    raw = readRestrictedRuntimeFile(bindingPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Managed gateway runtime binding '${bindingPath}' is malformed.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Managed gateway runtime binding '${bindingPath}' is malformed.`);
  }
  const candidate = parsed as Partial<ManagedGatewayRuntimeBinding>;
  if (
    candidate.version !== MANAGED_GATEWAY_RUNTIME_BINDING_VERSION ||
    typeof candidate.driverName !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(candidate.driverName) ||
    typeof candidate.configSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.configSha256) ||
    !candidate.values ||
    typeof candidate.values !== "object" ||
    Array.isArray(candidate.values)
  ) {
    throw new Error(`Managed gateway runtime binding '${bindingPath}' is malformed.`);
  }
  const values: Record<string, ManagedGatewayRuntimeValue> = {};
  for (const [key, value] of Object.entries(candidate.values)) {
    if (
      !/^[a-z][a-z0-9_]*$/u.test(key) ||
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    ) {
      throw new Error(`Managed gateway runtime binding '${bindingPath}' is malformed.`);
    }
    values[key] = value;
  }
  const configPath = path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME);
  const configText = readRestrictedRuntimeFile(configPath);
  if (sha256(configText) !== candidate.configSha256) {
    throw new Error("Managed gateway runtime binding does not match its gateway configuration.");
  }
  return {
    version: MANAGED_GATEWAY_RUNTIME_BINDING_VERSION,
    driverName: candidate.driverName,
    configSha256: candidate.configSha256,
    values,
  };
}

export function clearManagedGatewayRuntimeBinding(stateDir: string): void {
  fs.rmSync(path.join(stateDir, MANAGED_GATEWAY_RUNTIME_BINDING_NAME), { force: true });
}

function cleanupStaleAtomicFileTemps(dir: string, basename: string): void {
  const prefix = `.${basename}.tmp-`;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix)) {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  }
}

function gatewayIdForStateDir(stateDir: string): string {
  const leaf = path.basename(path.resolve(stateDir)).replace(/[^A-Za-z0-9_.-]/g, "-");
  return leaf ? `nemoclaw-${leaf}` : "nemoclaw";
}

function gatewayLocalTlsDir(gatewayEnv: Record<string, string>): string {
  const localTlsDir = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR?.trim();
  if (!localTlsDir) {
    throw new Error("OpenShell Docker-driver gateway mTLS requires OPENSHELL_LOCAL_TLS_DIR");
  }
  return localTlsDir;
}

export interface ManagedGatewayDriverConfig {
  readonly driverName: string;
  readonly entries: readonly (readonly [string, string | number | boolean | undefined])[];
  /**
   * Explicit non-secret identity required to recover this runtime.
   *
   * Driver config entries are not persisted by default: future adapters may
   * add credentials or tokens to their gateway config, and those must never
   * leak into the host-side recovery binding accidentally.
   */
  readonly persistedRuntimeKeys: readonly string[];
}

function renderManagedGatewayDriverConfig(config: ManagedGatewayDriverConfig): string {
  return config.entries
    .filter(
      (entry): entry is readonly [string, string | number | boolean] =>
        entry[1] !== undefined && (typeof entry[1] !== "string" || entry[1].trim() !== ""),
    )
    .map(
      ([key, value]) => `${key} = ${typeof value === "string" ? tomlString(value) : String(value)}`,
    )
    .join("\n");
}

export function buildManagedDriverGatewayConfigToml(
  gatewayEnv: Record<string, string>,
  driver: ManagedGatewayDriverConfig,
  jwtBundle?: DockerDriverGatewayJwtBundle | null,
  gatewayId = "nemoclaw",
): string {
  const localTlsDir = jwtBundle ? gatewayLocalTlsDir(gatewayEnv) : undefined;
  const driverConfig = renderManagedGatewayDriverConfig(driver);
  const sections = [
    "[openshell]",
    "version = 1",
    "",
    "[openshell.gateway]",
    `compute_drivers = [${tomlString(driver.driverName)}]`,
    "disable_tls = false",
    "",
  ];

  if (jwtBundle) {
    const tlsDir = localTlsDir ?? gatewayLocalTlsDir(gatewayEnv);
    sections.push(
      "[openshell.gateway.tls]",
      `cert_path = ${tomlString(path.join(tlsDir, "server", "tls.crt"))}`,
      `key_path = ${tomlString(path.join(tlsDir, "server", "tls.key"))}`,
      `client_ca_path = ${tomlString(path.join(tlsDir, "ca.crt"))}`,
      "require_client_auth = true",
      "",
      "[openshell.gateway.mtls_auth]",
      "enabled = true",
      "",
      "[openshell.gateway.gateway_jwt]",
      `signing_key_path = ${tomlString(jwtBundle.signingKeyPath)}`,
      `public_key_path = ${tomlString(jwtBundle.publicKeyPath)}`,
      `kid_path = ${tomlString(jwtBundle.kidPath)}`,
      `gateway_id = ${tomlString(gatewayId)}`,
      `ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`,
      "",
      "[openshell.gateway.auth]",
      "allow_unauthenticated_users = false",
      "",
    );
  }

  sections.push(`[openshell.drivers.${driver.driverName}]`);
  if (driverConfig) sections.push(driverConfig);
  sections.push("");
  return sections.join("\n");
}

export function buildDockerDriverGatewayConfigToml(
  gatewayEnv: Record<string, string>,
  sandboxBin?: string | null,
  jwtBundle?: DockerDriverGatewayJwtBundle | null,
  gatewayId = "nemoclaw",
): string {
  const localTlsDir = jwtBundle ? gatewayLocalTlsDir(gatewayEnv) : undefined;
  const dockerEntries: readonly (readonly [string, string | undefined])[] = [
    ["grpc_endpoint", gatewayEnv.OPENSHELL_GRPC_ENDPOINT],
    ["network_name", gatewayEnv.OPENSHELL_DOCKER_NETWORK_NAME],
    ["supervisor_image", gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_IMAGE],
    ["supervisor_bin", sandboxBin ?? undefined],
    ["guest_tls_ca", localTlsDir ? path.join(localTlsDir, "ca.crt") : undefined],
    ["guest_tls_cert", localTlsDir ? path.join(localTlsDir, "client", "tls.crt") : undefined],
    ["guest_tls_key", localTlsDir ? path.join(localTlsDir, "client", "tls.key") : undefined],
  ];
  return buildManagedDriverGatewayConfigToml(
    gatewayEnv,
    { driverName: "docker", entries: dockerEntries, persistedRuntimeKeys: [] },
    jwtBundle,
    gatewayId,
  );
}

export function writeManagedDriverGatewayConfig(
  stateDir: string,
  gatewayEnv: Record<string, string>,
  driver: ManagedGatewayDriverConfig,
): string {
  const configPath = path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME);
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  const configText = buildManagedDriverGatewayConfigToml(
    gatewayEnv,
    driver,
    jwtBundle,
    gatewayIdForStateDir(stateDir),
  );
  writeRestrictedFileAtomic(configPath, configText, 0o600);
  writeManagedGatewayRuntimeBinding(stateDir, driver, configText);
  return configPath;
}

export function writeDockerDriverGatewayConfig(
  stateDir: string,
  gatewayEnv: Record<string, string>,
  sandboxBin?: string | null,
): string {
  const localTlsDir = gatewayLocalTlsDir(gatewayEnv);
  return writeManagedDriverGatewayConfig(stateDir, gatewayEnv, {
    driverName: "docker",
    persistedRuntimeKeys: [],
    entries: [
      ["grpc_endpoint", gatewayEnv.OPENSHELL_GRPC_ENDPOINT],
      ["network_name", gatewayEnv.OPENSHELL_DOCKER_NETWORK_NAME],
      ["supervisor_image", gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_IMAGE],
      ["supervisor_bin", sandboxBin ?? undefined],
      ["guest_tls_ca", path.join(localTlsDir, "ca.crt")],
      ["guest_tls_cert", path.join(localTlsDir, "client", "tls.crt")],
      ["guest_tls_key", path.join(localTlsDir, "client", "tls.key")],
    ],
  });
}

export function prepareDockerDriverGatewayConfigEnv(
  gatewayEnv: Record<string, string>,
  stateDir: string,
  sandboxBin?: string | null,
): Record<string, string> {
  gatewayEnv.OPENSHELL_GATEWAY_CONFIG = writeDockerDriverGatewayConfig(
    stateDir,
    gatewayEnv,
    sandboxBin,
  );
  return gatewayEnv;
}
