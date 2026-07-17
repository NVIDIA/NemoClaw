// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { REQUIRED_OPENSHELL_MCP_FEATURES } from "../../../src/lib/onboard/openshell-feature-gate.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { LifecyclePhaseFixture } from "../fixtures/phases/lifecycle.ts";
import {
  createOpenShellDriverConfigTestWrapper,
  type OpenShellComponents,
  type OpenShellDriverConfigTestWrapper,
  resolveOpenShellSiblingComponents,
  withOpenShellDriverConfigWrapperEnv,
} from "./openshell-driver-config-test-wrapper.ts";

export const EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV = "NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF";
export const EXACT_MAIN_TMPFS_TARGET = "/tmp/nemoclaw-exact-main-driver-config";
export const EXACT_MAIN_TMPFS_MOUNT = {
  type: "tmpfs",
  target: EXACT_MAIN_TMPFS_TARGET,
  options: ["noexec"],
  size_bytes: 16_777_216,
  mode: 0o1777,
} as const;
export const EXACT_MAIN_DRIVER_CONFIG_JSON = JSON.stringify({
  docker: { mounts: [EXACT_MAIN_TMPFS_MOUNT] },
  podman: { mounts: [EXACT_MAIN_TMPFS_MOUNT] },
});

const DEFAULT_GATEWAY_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "nemoclaw",
  "openshell-docker-gateway",
);
const GATEWAY_CONFIG_NAME = "openshell-gateway.toml";
const GATEWAY_PID_NAME = "openshell-gateway.pid";
const SANDBOX_LABEL = "openshell.ai/sandbox-name";
const TMPFS_MARKER = `${EXACT_MAIN_TMPFS_TARGET}/candidate-main-marker`;
const DURABLE_MARKER = "/sandbox/.deepagents/.state/candidate-main-driver-config-marker";
const SUPERVISOR_TARGET = "/opt/openshell/bin/openshell-sandbox";
const SANDBOX_TOKEN_TARGET = "/etc/openshell/auth/sandbox.jwt";
const TLS_MOUNT_TARGETS = [
  "/etc/openshell/tls/client/ca.crt",
  "/etc/openshell/tls/client/tls.crt",
  "/etc/openshell/tls/client/tls.key",
] as const;

type JsonRecord = Record<string, unknown>;

type CandidateProvenance = {
  artifacts?: {
    cli?: { binarySha256?: unknown };
    gateway?: { binarySha256?: unknown };
    standaloneSandbox?: { binarySha256?: unknown };
  };
  sourceSha?: unknown;
};

type ParsedGatewayConfig = {
  configSha256: string;
  endpoint: string;
  gatewayId: string;
  networkName: string;
  port: number;
  supervisorImage: string;
};

type DockerMount = {
  Destination?: unknown;
  RW?: unknown;
  Source?: unknown;
  Type?: unknown;
};

type RuntimeSnapshot = {
  bridgeAddress: string;
  config: ParsedGatewayConfig;
  containerId: string;
  gatewayBinarySha256: string;
  gatewayPid: number;
};

export type ExactMainDriverConfigProof = {
  active: boolean;
  assertAfterOnboard(): Promise<void>;
  assertAfterRebuild(): Promise<void>;
  baseline?: RuntimeSnapshot;
  components?: OpenShellComponents;
  durableMarkerValue?: string;
  envOverlay: NodeJS.ProcessEnv;
  postRestart?: RuntimeSnapshot;
  provenance?: CandidateProvenance;
  wrapper?: OpenShellDriverConfigTestWrapper;
};

type ExactMainDriverConfigFixture = {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  host: HostCliClient;
  lifecycle: LifecyclePhaseFixture;
  sandbox: SandboxClient;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be a TOML table`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function gatewayStateDir(): string {
  return process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim() || DEFAULT_GATEWAY_STATE_DIR;
}

function assertRestrictedRegularFile(filePath: string, label: string): void {
  const stat = fs.statSync(filePath);
  expect(stat.isFile(), `${label} must be a regular file`).toBe(true);
  expect(stat.mode & 0o777, `${label} must be mode 0600`).toBe(0o600);
}

function assertReadableRegularFile(filePath: string, label: string): void {
  const stat = fs.statSync(filePath);
  expect(stat.isFile(), `${label} must be a regular file`).toBe(true);
  fs.accessSync(filePath, fs.constants.R_OK);
}

function readCandidateProvenance(artifacts: ArtifactSink): CandidateProvenance {
  const provenancePath = path.join(artifacts.rootDir, "openshell-exact-main-provenance.json");
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8")) as CandidateProvenance;
  expect(provenance.sourceSha, "exact-main provenance must name a full source SHA").toMatch(
    /^[0-9a-f]{40}$/,
  );
  return provenance;
}

function expectedBinarySha(
  provenance: CandidateProvenance,
  role: "cli" | "gateway" | "standaloneSandbox",
): string {
  return requireString(provenance.artifacts?.[role]?.binarySha256, `${role} binary SHA-256`);
}

function readRenderedGatewayConfig(proof: ExactMainDriverConfigProof): ParsedGatewayConfig {
  const components = proof.components;
  if (!components) throw new Error("exact-main OpenShell components were not prepared");
  const stateDir = gatewayStateDir();
  const configPath = path.join(stateDir, GATEWAY_CONFIG_NAME);
  assertRestrictedRegularFile(configPath, "rendered OpenShell gateway config");
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = requireRecord(parseToml(raw), "rendered OpenShell config");
  const openshell = requireRecord(parsed.openshell, "openshell");
  expect(openshell.version).toBe(1);
  const gateway = requireRecord(openshell.gateway, "openshell.gateway");
  expect(gateway.compute_drivers).toEqual(["docker"]);
  expect(gateway.disable_tls).toBe(false);
  const tls = requireRecord(gateway.tls, "openshell.gateway.tls");
  expect(tls.require_client_auth).toBe(true);
  const mtls = requireRecord(gateway.mtls_auth, "openshell.gateway.mtls_auth");
  expect(mtls.enabled).toBe(true);
  const auth = requireRecord(gateway.auth, "openshell.gateway.auth");
  expect(auth.allow_unauthenticated_users).toBe(false);
  const jwt = requireRecord(gateway.gateway_jwt, "openshell.gateway.gateway_jwt");
  expect(requireInteger(jwt.ttl_secs, "gateway JWT ttl_secs")).toBe(0);
  const gatewayId = requireString(jwt.gateway_id, "gateway JWT gateway_id");
  for (const key of ["signing_key_path", "public_key_path", "kid_path"] as const) {
    const filePath = requireString(jwt[key], `gateway JWT ${key}`);
    expect(path.isAbsolute(filePath), `gateway JWT ${key} must be absolute`).toBe(true);
    assertRestrictedRegularFile(filePath, `gateway JWT ${key}`);
  }

  const drivers = requireRecord(openshell.drivers, "openshell.drivers");
  expect(
    Object.keys(drivers),
    "NemoClaw must render only the selected Docker driver table",
  ).toEqual(["docker"]);
  const docker = requireRecord(drivers.docker, "openshell.drivers.docker");
  const endpoint = requireString(docker.grpc_endpoint, "Docker grpc_endpoint");
  const endpointUrl = new URL(endpoint);
  expect(endpointUrl.protocol).toBe("https:");
  expect(endpointUrl.hostname).toBe("127.0.0.1");
  const port = Number(endpointUrl.port);
  expect(Number.isSafeInteger(port) && port > 0 && port <= 65_535).toBe(true);
  const networkName = requireString(docker.network_name, "Docker network_name");
  const supervisorImage = requireString(docker.supervisor_image, "Docker supervisor_image");
  expect(supervisorImage).toBe(process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE);
  expect(fs.realpathSync(requireString(docker.supervisor_bin, "Docker supervisor_bin"))).toBe(
    components.sandbox,
  );

  const clientCa = requireString(tls.client_ca_path, "gateway TLS client_ca_path");
  expect(requireString(docker.guest_tls_ca, "Docker guest_tls_ca")).toBe(clientCa);
  assertReadableRegularFile(
    requireString(tls.cert_path, "gateway TLS cert_path"),
    "gateway TLS cert_path",
  );
  assertRestrictedRegularFile(
    requireString(tls.key_path, "gateway TLS key_path"),
    "gateway TLS key_path",
  );
  assertReadableRegularFile(clientCa, "gateway TLS client_ca_path");
  assertReadableRegularFile(
    requireString(docker.guest_tls_ca, "Docker guest_tls_ca"),
    "Docker guest_tls_ca",
  );
  assertReadableRegularFile(
    requireString(docker.guest_tls_cert, "Docker guest_tls_cert"),
    "Docker guest_tls_cert",
  );
  assertRestrictedRegularFile(
    requireString(docker.guest_tls_key, "Docker guest_tls_key"),
    "Docker guest_tls_key",
  );

  return {
    configSha256: createHash("sha256").update(raw).digest("hex"),
    endpoint,
    gatewayId,
    networkName,
    port,
    supervisorImage,
  };
}

function readGatewayPid(): number {
  const raw = fs.readFileSync(path.join(gatewayStateDir(), GATEWAY_PID_NAME), "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`invalid OpenShell gateway pid '${raw}'`);
  const pid = Number(raw);
  process.kill(pid, 0);
  return pid;
}

async function requireDockerBridgeAddress(
  host: HostCliClient,
  networkName: string,
  phase: string,
): Promise<string> {
  const result = await host.command(
    "docker",
    ["network", "inspect", networkName, "--format", "{{json .IPAM.Config}}"],
    {
      artifactName: `exact-main-driver-network-${phase}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  const configs = JSON.parse(result.stdout.trim()) as Array<{
    Gateway?: unknown;
  }>;
  const gateway = configs
    .map((config) => config.Gateway)
    .find((value): value is string => typeof value === "string" && isIP(value) === 4);
  return requireString(gateway, "Docker network IPv4 gateway");
}

async function requireRunningSandboxContainer(
  host: HostCliClient,
  sandboxName: string,
  phase: string,
): Promise<string> {
  const result = await host.command(
    "docker",
    [
      "ps",
      "--no-trunc",
      "--filter",
      `label=${SANDBOX_LABEL}=${sandboxName}`,
      "--format",
      "{{.ID}}",
    ],
    {
      artifactName: `exact-main-driver-container-${phase}`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  const ids = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  expect(ids, `expected exactly one running Docker container for ${sandboxName}`).toHaveLength(1);
  return ids[0]!;
}

async function inspectJson<T>(
  host: HostCliClient,
  containerId: string,
  template: string,
  artifactName: string,
): Promise<T> {
  const result = await host.command("docker", ["inspect", "--format", template, containerId], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return JSON.parse(result.stdout.trim()) as T;
}

async function assertRuntimeMounts(
  host: HostCliClient,
  proof: ExactMainDriverConfigProof,
  config: ParsedGatewayConfig,
  containerId: string,
  phase: string,
): Promise<void> {
  const components = proof.components!;
  const mounts = await inspectJson<DockerMount[]>(
    host,
    containerId,
    "{{json .Mounts}}",
    `exact-main-driver-mounts-${phase}`,
  );
  const tmpfs = mounts.filter((mount) => mount.Destination === EXACT_MAIN_TMPFS_TARGET);
  expect(tmpfs).toHaveLength(1);
  expect(tmpfs[0]).toMatchObject({ Type: "tmpfs", RW: true });
  const supervisor = mounts.find((mount) => mount.Destination === SUPERVISOR_TARGET);
  expect(supervisor).toMatchObject({ Type: "bind", RW: false });
  expect(fs.realpathSync(requireString(supervisor?.Source, "supervisor bind source"))).toBe(
    components.sandbox,
  );
  for (const target of [...TLS_MOUNT_TARGETS, SANDBOX_TOKEN_TARGET]) {
    expect(mounts.find((mount) => mount.Destination === target)).toMatchObject({
      Type: "bind",
      RW: false,
    });
  }
  const binds = await inspectJson<unknown>(
    host,
    containerId,
    "{{json .HostConfig.Binds}}",
    `exact-main-driver-binds-${phase}`,
  );
  expect(
    Array.isArray(binds) && binds.some((bind) => String(bind).includes(EXACT_MAIN_TMPFS_TARGET)),
    "the reviewed tmpfs must stay on Docker's structured Mount path, not SELinux legacy Binds",
  ).toBe(false);
  const networks = await inspectJson<JsonRecord>(
    host,
    containerId,
    "{{json .NetworkSettings.Networks}}",
    `exact-main-driver-container-networks-${phase}`,
  );
  expect(networks[config.networkName], `sandbox must join ${config.networkName}`).toBeDefined();
}

async function assertGatewayListeners(
  host: HostCliClient,
  gatewayPid: number,
  config: ParsedGatewayConfig,
  bridgeAddress: string,
  phase: string,
): Promise<void> {
  const listeners = await host.command("ss", ["-H", "-ltnp"], {
    artifactName: `exact-main-driver-listeners-${phase}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(listeners.exitCode, resultText(listeners)).toBe(0);
  const owned = resultText(listeners)
    .split(/\r?\n/)
    .filter((line) => line.includes(`pid=${gatewayPid},`));
  expect(owned.some((line) => line.includes(`127.0.0.1:${config.port}`))).toBe(true);
  expect(owned.some((line) => line.includes(`${bridgeAddress}:${config.port}`))).toBe(true);
  expect(owned.some((line) => line.includes(`0.0.0.0:${config.port}`))).toBe(false);
}

async function captureRuntimeSnapshot(options: {
  host: HostCliClient;
  phase: string;
  proof: ExactMainDriverConfigProof;
  sandbox: SandboxClient;
  sandboxName: string;
}): Promise<RuntimeSnapshot> {
  const { host, phase, proof, sandbox, sandboxName } = options;
  const components = proof.components!;
  const provenance = proof.provenance!;
  const config = readRenderedGatewayConfig(proof);
  const gatewayPid = readGatewayPid();
  const gatewayExe = fs.realpathSync(`/proc/${gatewayPid}/exe`);
  expect(gatewayExe, "running gateway must be the reviewed candidate binary").toBe(
    components.gateway,
  );
  const gatewayBinarySha256 = sha256File(gatewayExe);
  expect(gatewayBinarySha256).toBe(expectedBinarySha(provenance, "gateway"));
  expect(sha256File(components.cli)).toBe(expectedBinarySha(provenance, "cli"));
  expect(sha256File(components.sandbox)).toBe(expectedBinarySha(provenance, "standaloneSandbox"));
  const bridgeAddress = await requireDockerBridgeAddress(host, config.networkName, phase);
  await assertGatewayListeners(host, gatewayPid, config, bridgeAddress, phase);
  const containerId = await requireRunningSandboxContainer(host, sandboxName, phase);
  await assertRuntimeMounts(host, proof, config, containerId, phase);
  await sandbox.expectListed(sandboxName, {
    artifactName: `exact-main-driver-openshell-list-${phase}`,
    timeoutMs: 60_000,
  });
  return {
    bridgeAddress,
    config,
    containerId,
    gatewayBinarySha256,
    gatewayPid,
  };
}

async function assertSandboxMountAndAuth(options: {
  phase: string;
  sandbox: SandboxClient;
  sandboxName: string;
  durableMarkerValue: string;
  tmpfsMarker: "absent" | "present" | "write";
}): Promise<void> {
  const markerCheck =
    options.tmpfsMarker === "write"
      ? `test ! -e ${TMPFS_MARKER}; printf '%s\\n' candidate-main > ${TMPFS_MARKER}`
      : options.tmpfsMarker === "present"
        ? `grep -Fx candidate-main ${TMPFS_MARKER} >/dev/null`
        : `test ! -e ${TMPFS_MARKER}`;
  const durableCheck =
    options.tmpfsMarker === "write"
      ? `mkdir -p /sandbox/.deepagents/.state; printf '%s\\n' '${options.durableMarkerValue}' > ${DURABLE_MARKER}`
      : `grep -Fx '${options.durableMarkerValue}' ${DURABLE_MARKER} >/dev/null`;
  const script = trustedSandboxShellScript(
    [
      "set -eu",
      `mount_line="$(awk '$2 == "${EXACT_MAIN_TMPFS_TARGET}" { print $3 " " $4; found = 1 } END { if (!found) exit 1 }' /proc/mounts)"`,
      'mount_type="${mount_line%% *}"',
      'mount_options="${mount_line#* }"',
      'test "$mount_type" = tmpfs',
      'case ",$mount_options," in *,noexec,*) ;; *) exit 1 ;; esac',
      `test "$(stat -c '%a' ${EXACT_MAIN_TMPFS_TARGET})" = 1777`,
      `test -r ${SANDBOX_TOKEN_TARGET} && test -s ${SANDBOX_TOKEN_TARGET}`,
      ...TLS_MOUNT_TARGETS.map((target) => `test -r ${target} && test -s ${target}`),
      markerCheck,
      durableCheck,
      `printf 'tmpfs=%s mode=%s auth_mounts=present\\n' "$mount_type" "$(stat -c '%a' ${EXACT_MAIN_TMPFS_TARGET})"`,
    ].join("\n"),
  );
  const result = await options.sandbox.execShell(options.sandboxName, script, {
    artifactName: `exact-main-driver-sandbox-${options.phase}`,
    env: sandboxAccessEnv(),
    timeoutMs: 60_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(resultText(result)).toContain("tmpfs=tmpfs mode=1777 auth_mounts=present");
}

async function writeSnapshotArtifact(
  artifacts: ArtifactSink,
  phase: string,
  proof: ExactMainDriverConfigProof,
  snapshot: RuntimeSnapshot,
  mountLifecycle: string,
): Promise<void> {
  await artifacts.writeJson(`exact-main-driver-config-${phase}.json`, {
    sourceSha: proof.provenance?.sourceSha,
    phase,
    selectedDriver: "docker",
    renderedConfigSha256: snapshot.config.configSha256,
    renderedEndpoint: snapshot.config.endpoint,
    networkName: snapshot.config.networkName,
    supervisorImage: snapshot.config.supervisorImage,
    gatewayBinarySha256: snapshot.gatewayBinarySha256,
    gatewayPid: snapshot.gatewayPid,
    containerId: snapshot.containerId,
    listeners: [
      `127.0.0.1:${snapshot.config.port}`,
      `${snapshot.bridgeAddress}:${snapshot.config.port}`,
    ],
    auth: {
      gatewayTls: "enabled",
      hostMtls: "required-and-list-succeeded",
      sandboxJwtAndMtls: "mounted-and-supervisor-relay-exec-succeeded",
      unauthenticatedUsers: "disabled",
    },
    mount: {
      target: EXACT_MAIN_TMPFS_TARGET,
      representation: "structured-tmpfs-not-bind",
      options: ["noexec"],
      mode: "1777",
      lifecycle: mountLifecycle,
    },
  });
}

export function prepareExactMainDriverConfigProof(
  fixture: ExactMainDriverConfigFixture,
  sandboxName: string,
): ExactMainDriverConfigProof {
  if (process.env[EXACT_MAIN_DRIVER_CONFIG_PROOF_ENV] !== "1") {
    return {
      active: false,
      assertAfterOnboard: async () => {},
      assertAfterRebuild: async () => {},
      envOverlay: {},
    };
  }
  if (process.platform !== "linux") {
    throw new Error("exact-main Docker driver-config proof is Linux-only");
  }
  const openshellPath = process.env.OPENSHELL_BIN?.trim();
  if (!openshellPath || !path.isAbsolute(openshellPath)) {
    throw new Error("exact-main Docker driver-config proof requires absolute OPENSHELL_BIN");
  }
  const components = resolveOpenShellSiblingComponents(openshellPath);
  const wrapper = createOpenShellDriverConfigTestWrapper({
    delegatedCapabilityMarkers: REQUIRED_OPENSHELL_MCP_FEATURES,
    driverConfigJson: EXACT_MAIN_DRIVER_CONFIG_JSON,
    label: "exact-main-driver-config",
    realOpenshellPath: components.cli,
  });
  fixture.cleanup.add("remove exact-main driver-config OpenShell wrapper", wrapper.remove);
  const envOverlay = withOpenShellDriverConfigWrapperEnv(
    { PATH: process.env.PATH ?? "" },
    wrapper,
    components,
  );
  const previousEnv = Object.fromEntries(
    Object.keys(envOverlay).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, envOverlay);
  fixture.cleanup.add("restore exact-main driver-config environment", () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const proof: ExactMainDriverConfigProof = {
    active: true,
    assertAfterOnboard: async () => {
      await assertExactMainDriverConfigBeforeRestart({
        artifacts: fixture.artifacts,
        host: fixture.host,
        proof,
        sandbox: fixture.sandbox,
        sandboxName,
      });
      await restartAndAssertExactMainDriverConfig({
        artifacts: fixture.artifacts,
        host: fixture.host,
        lifecycle: fixture.lifecycle,
        proof,
        sandbox: fixture.sandbox,
        sandboxName,
      });
    },
    assertAfterRebuild: async () => {
      await assertExactMainDriverConfigAfterRebuild({
        artifacts: fixture.artifacts,
        host: fixture.host,
        proof,
        sandbox: fixture.sandbox,
        sandboxName,
      });
    },
    components,
    durableMarkerValue: `candidate-main-${randomUUID()}`,
    envOverlay,
    wrapper,
  };
  return proof;
}

export async function assertExactMainDriverConfigBeforeRestart(options: {
  artifacts: ArtifactSink;
  host: HostCliClient;
  proof: ExactMainDriverConfigProof;
  sandbox: SandboxClient;
  sandboxName: string;
}): Promise<void> {
  if (!options.proof.active) return;
  options.proof.provenance = readCandidateProvenance(options.artifacts);
  const snapshot = await captureRuntimeSnapshot({
    ...options,
    phase: "before-restart",
  });
  await assertSandboxMountAndAuth({
    phase: "before-restart",
    sandbox: options.sandbox,
    sandboxName: options.sandboxName,
    durableMarkerValue: options.proof.durableMarkerValue!,
    tmpfsMarker: "write",
  });
  options.proof.baseline = snapshot;
  await writeSnapshotArtifact(
    options.artifacts,
    "before-restart",
    options.proof,
    snapshot,
    "mounted-after-candidate-onboard",
  );
}

export async function restartAndAssertExactMainDriverConfig(options: {
  artifacts: ArtifactSink;
  host: HostCliClient;
  lifecycle: LifecyclePhaseFixture;
  proof: ExactMainDriverConfigProof;
  sandbox: SandboxClient;
  sandboxName: string;
}): Promise<void> {
  if (!options.proof.active) return;
  const baseline = options.proof.baseline;
  if (!baseline) throw new Error("exact-main baseline snapshot is missing");
  await options.lifecycle.restartGatewayRuntime({
    delayMs: 1_000,
    sandboxName: options.sandboxName,
  });
  await options.lifecycle.waitForGatewayConnected({
    attempts: 60,
    intervalMs: 2_000,
  });
  const snapshot = await captureRuntimeSnapshot({
    ...options,
    phase: "after-gateway-restart",
  });
  expect(snapshot.gatewayPid, "host OpenShell gateway restart must replace the process").not.toBe(
    baseline.gatewayPid,
  );
  expect(snapshot.containerId, "gateway restart must retain the sandbox container").toBe(
    baseline.containerId,
  );
  expect(snapshot.config.configSha256, "rendered selected-driver config must be stable").toBe(
    baseline.config.configSha256,
  );
  // OpenShell's graceful gateway shutdown stops managed Docker sandboxes and
  // startup resumes them. Docker therefore remounts the same container's
  // volatile tmpfs empty while the durable /sandbox state survives.
  await assertSandboxMountAndAuth({
    phase: "after-gateway-restart",
    sandbox: options.sandbox,
    sandboxName: options.sandboxName,
    durableMarkerValue: options.proof.durableMarkerValue!,
    tmpfsMarker: "absent",
  });
  await options.host.expectListed(options.sandboxName, {
    artifactName: "exact-main-driver-nemoclaw-list-after-gateway-restart",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  await options.host.expectStatus(options.sandboxName, {
    artifactName: "exact-main-driver-nemoclaw-status-after-gateway-restart",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 120_000,
  });
  options.proof.postRestart = snapshot;
  await writeSnapshotArtifact(
    options.artifacts,
    "after-gateway-restart",
    options.proof,
    snapshot,
    "same-container-tmpfs-remounted-and-durable-state-retained",
  );
}

export async function assertExactMainDriverConfigAfterRebuild(options: {
  artifacts: ArtifactSink;
  host: HostCliClient;
  proof: ExactMainDriverConfigProof;
  sandbox: SandboxClient;
  sandboxName: string;
}): Promise<void> {
  if (!options.proof.active) return;
  const prior = options.proof.postRestart;
  if (!prior) throw new Error("exact-main post-restart snapshot is missing");
  const snapshot = await captureRuntimeSnapshot({
    ...options,
    phase: "after-rebuild",
  });
  expect(
    snapshot.containerId,
    "NemoClaw rebuild must replace the Docker sandbox container",
  ).not.toBe(prior.containerId);
  expect(snapshot.config.configSha256, "rendered selected-driver config must survive rebuild").toBe(
    prior.config.configSha256,
  );
  await assertSandboxMountAndAuth({
    phase: "after-rebuild",
    sandbox: options.sandbox,
    sandboxName: options.sandboxName,
    durableMarkerValue: options.proof.durableMarkerValue!,
    tmpfsMarker: "absent",
  });
  await writeSnapshotArtifact(
    options.artifacts,
    "after-rebuild",
    options.proof,
    snapshot,
    "fresh-tmpfs-remounted-and-deepagents-state-restored",
  );
}
