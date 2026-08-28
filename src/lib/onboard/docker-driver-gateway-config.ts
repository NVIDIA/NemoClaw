// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { type OpenRegularFile, openRegularFileNoFollow } from "../adapters/fs/regular-file";
import {
  type DockerDriverGatewayJwtBundle,
  ensureDockerDriverGatewayJwtBundle,
} from "./docker-driver-gateway-jwt-bundle";
import { PORTABLE_HOST_GATEWAY_IP } from "./docker-driver-platform";
import { parseDockerDriverGatewayRuntimeMarker } from "./docker-driver-gateway-runtime-marker";
import { noteOnboardResumeHintShown } from "./resume-hint";

export type { DockerDriverGatewayJwtBundle } from "./docker-driver-gateway-jwt-bundle";
export { ensureDockerDriverGatewayJwtBundle } from "./docker-driver-gateway-jwt-bundle";

// See docs/security/gateway-authentication-controls.mdx for the public compatibility boundary.
export const DOCKER_DRIVER_GATEWAY_CONFIG_NAME = "openshell-gateway.toml";
export const DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS = 0;
const LEGACY_DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS = 3600;
const PRE_AUTH_DOCKER_DRIVER_GATEWAY_VERSION = "0.0.44";
export const NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV = "NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE";

type DockerDriverGatewayDriver = "docker" | "podman";

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
}

interface RegularFileProof {
  bytes: Buffer;
  file: OpenRegularFile;
  identity: FileIdentity;
  path: string;
}

interface ExistingConfigProof extends RegularFileProof {
  stateDir: string;
  stateDirIdentity: FileIdentity;
}

interface LegacyJwtBundleProof {
  bundle: DockerDriverGatewayJwtBundle;
  directoryIdentity: FileIdentity;
  files: RegularFileProof[];
  jwtDir: string;
}

interface LegacyGatewayIdentity {
  configProof: ExistingConfigProof;
  gatewayId: string;
  jwtProof: LegacyJwtBundleProof;
  kind: "legacy";
  sandboxNamespace: "default";
}

type DockerDriverGatewayIdentity =
  | LegacyGatewayIdentity
  | {
      configProof: ExistingConfigProof | null;
      kind: "scoped";
      gatewayId: string;
      sandboxNamespace: string;
    };

function fileIdentity(stats: fs.Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode & 0o777, uid: stats.uid };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function assertStateDirectoryIdentity(stateDir: string, expected: FileIdentity): void {
  const current = fs.lstatSync(stateDir);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFileIdentity(fileIdentity(current), expected)
  ) {
    throw new Error(
      `Gateway state directory changed during legacy identity validation: ${stateDir}`,
    );
  }
}

function assertRegularFileProof(proof: RegularFileProof): void {
  const current = fs.lstatSync(proof.path);
  if (!sameFileIdentity(fileIdentity(current), proof.identity)) {
    throw new Error(`File changed during gateway identity validation: ${proof.path}`);
  }
  if (!proof.file.readBytes(64 * 1024).equals(proof.bytes)) {
    throw new Error(`File contents changed during gateway identity validation: ${proof.path}`);
  }
}

function closeRegularFileProof(proof: RegularFileProof): void {
  proof.file.close();
}

function assertExistingConfigProof(proof: ExistingConfigProof): void {
  assertStateDirectoryIdentity(proof.stateDir, proof.stateDirIdentity);
  assertRegularFileProof(proof);
}

function closeLegacyJwtBundleProof(proof: LegacyJwtBundleProof): void {
  for (const file of proof.files) closeRegularFileProof(file);
}

function assertLegacyJwtBundleProof(proof: LegacyJwtBundleProof): void {
  const currentDirectory = fs.lstatSync(proof.jwtDir);
  if (!sameFileIdentity(fileIdentity(currentDirectory), proof.directoryIdentity)) {
    throw new Error(`Legacy gateway JWT directory changed during validation: ${proof.jwtDir}`);
  }
  for (const file of proof.files) assertRegularFileProof(file);
}

function openOwnedLegacyJwtBundle(stateDir: string, ownerUid: number): LegacyJwtBundleProof {
  const jwtDir = path.join(stateDir, "jwt");
  let directoryState: fs.Stats;
  try {
    directoryState = fs.lstatSync(jwtDir);
  } catch (error) {
    throw new Error(`Legacy gateway JWT bundle is incomplete or unsafe: ${jwtDir}`, {
      cause: error,
    });
  }
  if (
    !directoryState.isDirectory() ||
    directoryState.isSymbolicLink() ||
    directoryState.uid !== ownerUid ||
    (directoryState.mode & 0o077) !== 0
  ) {
    throw new Error(`Legacy gateway JWT directory is not private and owner-controlled: ${jwtDir}`);
  }
  const directoryIdentity = fileIdentity(directoryState);
  const files: RegularFileProof[] = [];
  const contents = new Map<string, Buffer>();
  try {
    for (const candidate of Object.values(gatewayJwtBundlePaths(stateDir))) {
      let file: OpenRegularFile;
      try {
        file = openRegularFileNoFollow(candidate);
      } catch (error) {
        throw new Error(`Legacy gateway JWT bundle is incomplete or unsafe: ${candidate}`, {
          cause: error,
        });
      }
      try {
        const state = fs.lstatSync(candidate);
        if (state.uid !== ownerUid || (state.mode & 0o077) !== 0) {
          throw new Error(
            `Legacy gateway JWT file is not private and owner-controlled: ${candidate}`,
          );
        }
        const bytes = file.readBytes(64 * 1024);
        if (bytes.length === 0) {
          throw new Error(`Legacy gateway JWT file is empty: ${candidate}`);
        }
        files.push({ bytes, file, identity: fileIdentity(state), path: candidate });
        contents.set(candidate, bytes);
      } catch (error) {
        file.close();
        throw error;
      }
    }
    const bundle = gatewayJwtBundlePaths(stateDir);
    try {
      const privateKey = createPrivateKey(contents.get(bundle.signingKeyPath) ?? Buffer.alloc(0));
      const publicKey = createPublicKey(contents.get(bundle.publicKeyPath) ?? Buffer.alloc(0));
      const kid = contents.get(bundle.kidPath)?.toString("utf-8").trim();
      const payload = Buffer.from("nemoclaw-legacy-gateway-jwt-bundle-check", "utf-8");
      if (
        !kid ||
        privateKey.asymmetricKeyType !== "ed25519" ||
        publicKey.asymmetricKeyType !== "ed25519" ||
        !verify(null, payload, publicKey, sign(null, payload, privateKey))
      ) {
        throw new Error("the keypair or key id is invalid");
      }
    } catch (error) {
      throw new Error(`Legacy gateway JWT bundle is invalid: ${jwtDir}`, { cause: error });
    }
    const proof = {
      bundle,
      directoryIdentity,
      files,
      jwtDir,
    };
    assertLegacyJwtBundleProof(proof);
    return proof;
  } catch (error) {
    for (const file of files) closeRegularFileProof(file);
    throw error;
  }
}

function gatewayStateHasDurableIdentityEvidence(
  stateDir: string,
  names: readonly string[],
): boolean {
  // A PID file and runtime marker describe a launch, not a durable gateway
  // identity. Pre-config OpenShell releases legitimately leave those files
  // behind when the installer retires their process. Only the database or JWT
  // bundle makes generating a new identity ambiguous.
  for (const name of names) {
    try {
      fs.lstatSync(path.join(stateDir, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

function hasOwnedPreAuthGatewayDatabaseState(stateDir: string, state: fs.Stats): boolean {
  if (
    typeof process.getuid !== "function" ||
    state.uid !== process.getuid() ||
    (state.mode & 0o777) !== 0o700
  ) {
    return false;
  }

  const databasePath = path.join(stateDir, "openshell.db");
  const markerPath = path.join(stateDir, "runtime.json");
  let database: OpenRegularFile | null = null;
  let marker: OpenRegularFile | null = null;
  try {
    database = openRegularFileNoFollow(databasePath);
    marker = openRegularFileNoFollow(markerPath);
    const databaseState = fs.lstatSync(databasePath);
    const markerState = fs.lstatSync(markerPath);
    if (
      databaseState.uid !== state.uid ||
      markerState.uid !== state.uid ||
      (markerState.mode & 0o077) !== 0
    ) {
      return false;
    }
    return (
      parseDockerDriverGatewayRuntimeMarker(marker.readUtf8(64 * 1024))?.openshellVersion ===
      PRE_AUTH_DOCKER_DRIVER_GATEWAY_VERSION
    );
  } catch {
    return false;
  } finally {
    database?.close();
    marker?.close();
  }
}

function ambiguousGatewayConfig(configPath: string, detail: string): Error {
  return new Error(
    `Refusing to rewrite ${configPath}: NemoClaw cannot prove its generated gateway identity (${detail})`,
  );
}

/**
 * The gateway state directory is shared by port, not by driver (#10071): a
 * Docker-driver gateway and the portable profile's Podman-driver gateway
 * resolve to the same default state directory when they use the same port.
 * A well-formed NemoClaw config generated for the other driver is not
 * evidence of tampering or corruption — it is the ordinary result of
 * switching profiles on a host that already onboarded with the other
 * driver. Distinguish that case from a genuinely ambiguous config so the
 * error names a concrete recovery path instead of a generic schema
 * complaint, and so the suggested recovery does not just repeat the exact
 * command that failed.
 */
class CrossDriverGatewayConflictError extends Error {}

function crossDriverGatewayConflict(
  configPath: string,
  stateDir: string,
  requestedDriver: DockerDriverGatewayDriver,
  configuredDriver: DockerDriverGatewayDriver,
): Error {
  return new CrossDriverGatewayConflictError(
    `Refusing to rewrite ${configPath}: it already configures a '${configuredDriver}'-driver ` +
      `OpenShell gateway, but this run selected the '${requestedDriver}' driver. NemoClaw does not ` +
      `share one gateway state directory between driver types. To switch drivers for NemoClaw-managed state, ` +
      `run the applicable \`nemoclaw uninstall\` path, then retry. Uninstall preserves externally managed ` +
      `or supervised state; resolve that state through its lifecycle authority instead. To run both drivers ` +
      `concurrently, select an unused port with NEMOCLAW_GATEWAY_PORT=<port> and a separate state ` +
      `directory with NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR=<path>. State directory: ${stateDir}`,
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function writeRestrictedFile(filePath: string, value: string, mode = 0o600): void {
  fs.writeFileSync(filePath, value, { encoding: "utf-8", mode });
  fs.chmodSync(filePath, mode);
}

function writeRestrictedFileAtomic(
  filePath: string,
  value: string,
  mode = 0o600,
  beforeCommit?: () => void,
): void {
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
    beforeCommit?.();
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

function legacyGatewayIdForStateDir(stateDir: string): string {
  const leaf = path.basename(path.resolve(stateDir)).replace(/[^A-Za-z0-9_.-]/g, "-");
  return leaf ? `nemoclaw-${leaf}` : "nemoclaw";
}

function gatewayJwtBundlePaths(stateDir: string): DockerDriverGatewayJwtBundle {
  const jwtDir = path.join(stateDir, "jwt");
  return {
    signingKeyPath: path.join(jwtDir, "signing.pem"),
    publicKeyPath: path.join(jwtDir, "public.pem"),
    kidPath: path.join(jwtDir, "kid"),
  };
}

function asTomlTable(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assignStringEnv(env: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string") env[key] = value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function existingGatewayIdentityFromConfig(
  stateDir: string,
  driver: DockerDriverGatewayDriver,
  allowOpenShell0044PreAuthDatabase = false,
): DockerDriverGatewayIdentity | null {
  const configPath = path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME);
  let configFile: OpenRegularFile | null = null;
  let configProof: ExistingConfigProof | null = null;
  let state: fs.Stats;
  try {
    state = fs.lstatSync(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw ambiguousGatewayConfig(configPath, "the state path is not a real directory");
  }

  let config: fs.Stats;
  try {
    config = fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const approvedPreAuthDatabase =
      allowOpenShell0044PreAuthDatabase && hasOwnedPreAuthGatewayDatabaseState(stateDir, state);
    if (
      gatewayStateHasDurableIdentityEvidence(
        stateDir,
        approvedPreAuthDatabase ? ["jwt"] : ["jwt", "openshell.db"],
      )
    ) {
      throw ambiguousGatewayConfig(configPath, "durable gateway state exists without a config");
    }
    return null;
  }

  if (typeof process.getuid !== "function") {
    throw ambiguousGatewayConfig(configPath, "ownership verification is unavailable");
  }
  if (state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) {
    throw ambiguousGatewayConfig(
      configPath,
      "the state directory is not owner-controlled with mode 0700",
    );
  }

  try {
    if (
      !config.isFile() ||
      config.isSymbolicLink() ||
      config.nlink !== 1 ||
      config.uid !== state.uid ||
      (config.mode & 0o077) !== 0
    ) {
      throw ambiguousGatewayConfig(configPath, "the config is not a private owned regular file");
    }
    try {
      configFile = openRegularFileNoFollow(configPath);
    } catch (error) {
      throw ambiguousGatewayConfig(
        configPath,
        `the config could not be opened safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const openedConfig = fs.lstatSync(configPath);
    if (
      openedConfig.uid !== state.uid ||
      openedConfig.dev !== config.dev ||
      openedConfig.ino !== config.ino ||
      openedConfig.mode !== config.mode
    ) {
      throw ambiguousGatewayConfig(configPath, "the config changed while it was opened");
    }
    let originalToml: string;
    try {
      originalToml = configFile.readBytes(64 * 1024).toString("utf-8");
    } catch (error) {
      throw ambiguousGatewayConfig(
        configPath,
        `the config could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    configProof = {
      bytes: Buffer.from(originalToml, "utf-8"),
      file: configFile,
      identity: fileIdentity(openedConfig),
      path: configPath,
      stateDir,
      stateDirIdentity: fileIdentity(state),
    };
    configFile = null;
    let parsed: Record<string, unknown> | null;
    try {
      parsed = asTomlTable(parseToml(originalToml));
    } catch (error) {
      throw ambiguousGatewayConfig(
        configPath,
        `the config is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const openshell = asTomlTable(parsed?.openshell);
    const gateway = asTomlTable(openshell?.gateway);
    const gatewayJwt = asTomlTable(gateway?.gateway_jwt);
    const drivers = asTomlTable(openshell?.drivers);
    const driverConfig = asTomlTable(drivers?.[driver]);
    if (!driverConfig && parsed && openshell && gateway && gatewayJwt && drivers) {
      const otherDriver: DockerDriverGatewayDriver = driver === "docker" ? "podman" : "docker";
      if (asTomlTable(drivers[otherDriver])) {
        let otherIdentity: DockerDriverGatewayIdentity | null = null;
        try {
          otherIdentity = existingGatewayIdentityFromConfig(
            stateDir,
            otherDriver,
            allowOpenShell0044PreAuthDatabase,
          );
          if (otherIdentity) {
            throw crossDriverGatewayConflict(configPath, stateDir, driver, otherDriver);
          }
        } finally {
          if (otherIdentity?.kind === "legacy") closeLegacyJwtBundleProof(otherIdentity.jwtProof);
          if (otherIdentity?.configProof) closeRegularFileProof(otherIdentity.configProof);
        }
      }
    }
    if (!parsed || !openshell || !gateway || !gatewayJwt || !drivers || !driverConfig) {
      throw ambiguousGatewayConfig(configPath, "the config does not match NemoClaw's schema");
    }
    const requiredDriverFields =
      driver === "docker"
        ? [
            "grpc_endpoint",
            "network_name",
            "supervisor_image",
            "guest_tls_ca",
            "guest_tls_cert",
            "guest_tls_key",
          ]
        : [
            "grpc_endpoint",
            "host_gateway_ip",
            "socket_path",
            "network_name",
            "supervisor_image",
            "guest_tls_ca",
            "guest_tls_cert",
            "guest_tls_key",
          ];
    if (!requiredDriverFields.every((field) => isNonEmptyString(driverConfig[field]))) {
      throw ambiguousGatewayConfig(configPath, "the driver config is incomplete");
    }

    const configuredGatewayId = gatewayJwt.gateway_id;
    const configuredGatewayJwtTtl = gatewayJwt.ttl_secs;
    const namespace = driverConfig.sandbox_namespace;
    const legacyGatewayId = legacyGatewayIdForStateDir(stateDir);
    const scopedGatewayId = gatewayIdForStateDir(stateDir);
    const hasLegacyNamespace =
      driver === "docker"
        ? namespace === undefined || namespace === "default"
        : namespace === undefined;
    const hasScopedNamespace =
      driver === "docker" ? namespace === scopedGatewayId : namespace === undefined;
    const isLegacy = configuredGatewayId === legacyGatewayId && hasLegacyNamespace;
    const isScoped = configuredGatewayId === scopedGatewayId && hasScopedNamespace;
    if (!isLegacy && !isScoped) {
      throw ambiguousGatewayConfig(
        configPath,
        "the JWT issuer and sandbox namespace are neither the legacy nor scoped identity",
      );
    }
    const canonicalGatewayJwtTtl =
      isLegacy && configuredGatewayJwtTtl === LEGACY_DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS
        ? LEGACY_DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS
        : DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS;

    const parsedEnv: Record<string, string> = {
      OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
    };
    if (driver === "podman") parsedEnv.OPENSHELL_DRIVERS = "podman";
    if (driverConfig.enable_bind_mounts === true) {
      parsedEnv.NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS = "1";
    }
    assignStringEnv(parsedEnv, "OPENSHELL_GRPC_ENDPOINT", driverConfig.grpc_endpoint);
    assignStringEnv(parsedEnv, "OPENSHELL_PODMAN_SOCKET", driverConfig.socket_path);
    assignStringEnv(parsedEnv, "OPENSHELL_DOCKER_NETWORK_NAME", driverConfig.network_name);
    assignStringEnv(parsedEnv, "OPENSHELL_DOCKER_SUPERVISOR_IMAGE", driverConfig.supervisor_image);
    const configuredSandboxBin =
      typeof driverConfig.supervisor_bin === "string" ? driverConfig.supervisor_bin : undefined;
    const canonicalToml = buildDockerDriverGatewayConfigTomlForIdentity(
      parsedEnv,
      configuredSandboxBin,
      gatewayJwtBundlePaths(stateDir),
      String(configuredGatewayId),
      typeof namespace === "string" ? namespace : null,
      canonicalGatewayJwtTtl,
    );
    if (originalToml !== canonicalToml) {
      throw ambiguousGatewayConfig(
        configPath,
        "the config does not match NemoClaw's generated form",
      );
    }

    if (isLegacy) {
      const identity: LegacyGatewayIdentity = {
        configProof,
        gatewayId: legacyGatewayId,
        jwtProof: openOwnedLegacyJwtBundle(stateDir, state.uid),
        kind: "legacy",
        sandboxNamespace: "default",
      };
      configProof = null;
      return identity;
    }

    if (isScoped) {
      const identity: DockerDriverGatewayIdentity = {
        configProof,
        gatewayId: scopedGatewayId,
        kind: "scoped",
        sandboxNamespace: scopedGatewayId,
      };
      configProof = null;
      return identity;
    }

    throw new Error("unreachable gateway identity classification");
  } finally {
    configFile?.close();
    if (configProof) closeRegularFileProof(configProof);
  }
}

function resolveDockerDriverGatewayIdentity(
  stateDir: string,
  gatewayEnv: Record<string, string>,
  allowOpenShell0044PreAuthDatabase = false,
): DockerDriverGatewayIdentity {
  const driver: DockerDriverGatewayDriver =
    gatewayEnv.OPENSHELL_DRIVERS === "podman" ? "podman" : "docker";
  const existing = existingGatewayIdentityFromConfig(
    stateDir,
    driver,
    allowOpenShell0044PreAuthDatabase,
  );
  if (existing) return existing;
  const gatewayId = gatewayIdForStateDir(stateDir);
  return { configProof: null, kind: "scoped", gatewayId, sandboxNamespace: gatewayId };
}

/** Prove that a NemoClaw-owned Docker gateway config uses its state-scoped namespace. */
export function hasStateScopedSandboxNamespace(stateDir: string): boolean {
  let identity: DockerDriverGatewayIdentity | null = null;
  try {
    identity = existingGatewayIdentityFromConfig(stateDir, "docker");
    return identity?.kind === "scoped";
  } catch {
    return false;
  } finally {
    if (identity?.kind === "legacy") closeLegacyJwtBundleProof(identity.jwtProof);
    if (identity?.configProof) closeRegularFileProof(identity.configProof);
  }
}

function gatewayLocalTlsDir(gatewayEnv: Record<string, string>): string {
  const localTlsDir = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR?.trim();
  if (!localTlsDir) {
    throw new Error("OpenShell Docker-driver gateway mTLS requires OPENSHELL_LOCAL_TLS_DIR");
  }
  return localTlsDir;
}

function buildDockerDriverGatewayConfigTomlForIdentity(
  gatewayEnv: Record<string, string>,
  sandboxBin?: string | null,
  jwtBundle?: DockerDriverGatewayJwtBundle | null,
  gatewayId = "nemoclaw",
  sandboxNamespace: string | null = gatewayId,
  gatewayJwtTtlSecs = DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
): string {
  const driver = gatewayEnv.OPENSHELL_DRIVERS === "podman" ? "podman" : "docker";
  const localTlsDir = jwtBundle ? gatewayLocalTlsDir(gatewayEnv) : undefined;
  const dockerEntries: [string, string | boolean | undefined][] = [
    ["enable_bind_mounts", gatewayEnv.NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS === "1" || undefined],
    ["sandbox_namespace", driver === "docker" ? (sandboxNamespace ?? undefined) : undefined],
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
      (entry): entry is [string, string | boolean] =>
        typeof entry[1] === "boolean" || (typeof entry[1] === "string" && entry[1].trim() !== ""),
    )
    .map(
      ([key, value]) =>
        `${key} = ${typeof value === "boolean" ? String(value) : tomlString(value)}`,
    )
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
      `ttl_secs = ${gatewayJwtTtlSecs}`,
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

export function buildDockerDriverGatewayConfigToml(
  gatewayEnv: Record<string, string>,
  sandboxBin?: string | null,
  jwtBundle?: DockerDriverGatewayJwtBundle | null,
  gatewayId = "nemoclaw",
): string {
  return buildDockerDriverGatewayConfigTomlForIdentity(
    gatewayEnv,
    sandboxBin,
    jwtBundle,
    gatewayId,
    gatewayId,
  );
}

function writeDockerDriverGatewayConfigWithIdentity(
  stateDir: string,
  gatewayEnv: Record<string, string>,
  sandboxBin: string | null | undefined,
  identity: DockerDriverGatewayIdentity,
): string {
  const configPath = path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME);
  if (identity.kind === "legacy") {
    try {
      assertExistingConfigProof(identity.configProof);
      assertLegacyJwtBundleProof(identity.jwtProof);
      writeRestrictedFileAtomic(
        configPath,
        buildDockerDriverGatewayConfigTomlForIdentity(
          gatewayEnv,
          sandboxBin,
          identity.jwtProof.bundle,
          identity.gatewayId,
          identity.sandboxNamespace,
        ),
        0o600,
        () => {
          assertExistingConfigProof(identity.configProof);
          assertLegacyJwtBundleProof(identity.jwtProof);
        },
      );
      // Existing containers and sandbox JWTs embed this namespace and
      // issuer. Other generated settings still follow the current runtime.
      return configPath;
    } finally {
      closeRegularFileProof(identity.configProof);
      closeLegacyJwtBundleProof(identity.jwtProof);
    }
  }
  try {
    if (identity.configProof) assertExistingConfigProof(identity.configProof);
    const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
    writeRestrictedFileAtomic(
      configPath,
      buildDockerDriverGatewayConfigToml(gatewayEnv, sandboxBin, jwtBundle, identity.gatewayId),
      0o600,
      identity.configProof ? () => assertExistingConfigProof(identity.configProof!) : undefined,
    );
    return configPath;
  } finally {
    if (identity.configProof) closeRegularFileProof(identity.configProof);
  }
}

export function writeDockerDriverGatewayConfig(
  stateDir: string,
  gatewayEnv: Record<string, string>,
  sandboxBin?: string | null,
): string {
  return writeDockerDriverGatewayConfigWithIdentity(
    stateDir,
    gatewayEnv,
    sandboxBin,
    resolveDockerDriverGatewayIdentity(stateDir, gatewayEnv),
  );
}

export function prepareDockerDriverGatewayConfigEnv(
  gatewayEnv: Record<string, string>,
  stateDir: string,
  sandboxBin?: string | null,
  options: { allowOpenShell0044PreAuthDatabase?: boolean } = {},
): Record<string, string> {
  let identity: DockerDriverGatewayIdentity;
  try {
    identity = resolveDockerDriverGatewayIdentity(
      stateDir,
      gatewayEnv,
      options.allowOpenShell0044PreAuthDatabase === true,
    );
  } catch (error) {
    if (error instanceof CrossDriverGatewayConflictError) {
      // The generic "onboard --resume" catch-all would repeat this exact
      // command and hit the identical conflict again. Mark the latch only at
      // the onboarding boundary that surfaces the tailored recovery error;
      // ownership probes intentionally swallow config-classification errors.
      noteOnboardResumeHintShown();
    }
    throw error;
  }
  gatewayEnv.OPENSHELL_GATEWAY_CONFIG = writeDockerDriverGatewayConfigWithIdentity(
    stateDir,
    gatewayEnv,
    sandboxBin,
    identity,
  );
  if (gatewayEnv.OPENSHELL_DRIVERS === "podman") {
    delete gatewayEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV];
  } else {
    gatewayEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV] = identity.sandboxNamespace;
  }
  return gatewayEnv;
}
