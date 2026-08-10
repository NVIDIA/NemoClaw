// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type DockerDriverGatewayJwtBundle,
  ensureDockerDriverGatewayJwtBundle,
} from "./docker-driver-gateway-jwt-bundle";
import { PORTABLE_HOST_GATEWAY_IP } from "./docker-driver-platform";

export type { DockerDriverGatewayJwtBundle } from "./docker-driver-gateway-jwt-bundle";
export { ensureDockerDriverGatewayJwtBundle } from "./docker-driver-gateway-jwt-bundle";

// See docs/security/openshell-0.0.72-compatibility-review.mdx for the source-of-truth review.
export const DOCKER_DRIVER_GATEWAY_CONFIG_NAME = "openshell-gateway.toml";
export const DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS = 0;
export const NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV = "NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE";

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

function cleanupStaleAtomicFileTemps(dir: string, basename: string): void {
  const prefix = `.${basename}.tmp-`;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix)) {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  }
}

export function gatewayIdForStateDir(stateDir: string): string {
  const leaf = path.basename(path.resolve(stateDir)).replace(/[^A-Za-z0-9_.-]/g, "-");
  const scope = `${String(process.getuid?.() ?? "unknown")}\0${path.resolve(stateDir)}`;
  const suffix = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  return `nemoclaw-${leaf || "gateway"}-${suffix}`;
}

/** Prove that a NemoClaw-owned Docker gateway config uses its state-scoped namespace. */
export function hasStateScopedSandboxNamespace(stateDir: string): boolean {
  if (typeof process.getuid !== "function" || typeof fs.constants.O_NOFOLLOW !== "number") {
    return false;
  }
  const configPath = path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME);
  let descriptor: number | undefined;
  try {
    const state = fs.lstatSync(stateDir);
    descriptor = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const config = fs.fstatSync(descriptor);
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      !config.isFile() ||
      config.nlink !== 1 ||
      state.uid !== process.getuid() ||
      config.uid !== state.uid ||
      config.size > 64 * 1024
    ) {
      return false;
    }
    const expected = `sandbox_namespace = ${tomlString(gatewayIdForStateDir(stateDir))}`;
    let inDriverTable = false;
    const matches = fs
      .readFileSync(descriptor, "utf-8")
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          inDriverTable = trimmed === "[openshell.drivers.docker]";
          return false;
        }
        return inDriverTable && trimmed.startsWith("sandbox_namespace =");
      });
    return matches.length === 1 && matches[0]?.trim() === expected;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function gatewayLocalTlsDir(gatewayEnv: Record<string, string>): string {
  const localTlsDir = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR?.trim();
  if (!localTlsDir) {
    throw new Error("OpenShell Docker-driver gateway mTLS requires OPENSHELL_LOCAL_TLS_DIR");
  }
  return localTlsDir;
}

export function buildDockerDriverGatewayConfigToml(
  gatewayEnv: Record<string, string>,
  sandboxBin?: string | null,
  jwtBundle?: DockerDriverGatewayJwtBundle | null,
  gatewayId = "nemoclaw",
): string {
  const driver = gatewayEnv.OPENSHELL_DRIVERS === "podman" ? "podman" : "docker";
  const localTlsDir = jwtBundle ? gatewayLocalTlsDir(gatewayEnv) : undefined;
  const dockerEntries: [string, string | undefined][] = [
    ["sandbox_namespace", driver === "docker" ? gatewayId : undefined],
    ["grpc_endpoint", gatewayEnv.OPENSHELL_GRPC_ENDPOINT],
    ["host_gateway_ip", driver === "podman" ? PORTABLE_HOST_GATEWAY_IP : undefined],
    ["socket_path", driver === "podman" ? gatewayEnv.OPENSHELL_PODMAN_SOCKET : undefined],
    ["network_name", gatewayEnv.OPENSHELL_DOCKER_NETWORK_NAME],
    ["supervisor_image", gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_IMAGE],
    // OpenShell 0.0.99 accepts supervisor_bin only for the Docker driver.
    // The Podman schema rejects the entire driver table when this Docker-only
    // field is present, so portable onboarding must rely on supervisor_image.
    ["supervisor_bin", driver === "docker" ? (sandboxBin ?? undefined) : undefined],
    ["guest_tls_ca", localTlsDir ? path.join(localTlsDir, "ca.crt") : undefined],
    ["guest_tls_cert", localTlsDir ? path.join(localTlsDir, "client", "tls.crt") : undefined],
    ["guest_tls_key", localTlsDir ? path.join(localTlsDir, "client", "tls.key") : undefined],
  ];
  const dockerConfig = dockerEntries
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
    )
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join("\n");

  const sections = [
    "[openshell]",
    "version = 1",
    "",
    "[openshell.gateway]",
    `compute_drivers = [${tomlString(driver)}]`,
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

  sections.push(`[openshell.drivers.${driver}]`);
  if (dockerConfig) sections.push(dockerConfig);
  sections.push("");

  return sections.join("\n");
}

export function writeDockerDriverGatewayConfig(
  stateDir: string,
  gatewayEnv: Record<string, string>,
  sandboxBin?: string | null,
): string {
  const configPath = path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME);
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  writeRestrictedFileAtomic(
    configPath,
    buildDockerDriverGatewayConfigToml(
      gatewayEnv,
      sandboxBin,
      jwtBundle,
      gatewayIdForStateDir(stateDir),
    ),
    0o600,
  );
  return configPath;
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
  if (gatewayEnv.OPENSHELL_DRIVERS === "podman") {
    delete gatewayEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV];
  } else {
    gatewayEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV] = gatewayIdForStateDir(stateDir);
  }
  return gatewayEnv;
}
