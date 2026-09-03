// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { assertPodmanSocketAuthority, type PodmanSocketAuthorityDeps } from "../../adapters/podman";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../runtime-provider/podman-lifecycle";
import type {
  HermesPortableConfiguredReceipt,
  HermesPortableContainerAuthority,
  HermesPortableLifecycleReceipt,
} from "./hermes-portable-receipt";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";

const FULL_ID = /^[a-f0-9]{64}$/u;
const SAFE = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const INSPECT_TIMEOUT_MS = 5_000;
const MUTATION_TIMEOUT_MS = 40_000;
const STOP_RECONCILIATION_TIMEOUT_MS = 30_000;
const STOP_RECONCILIATION_INTERVAL_MS = 1_000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const PODMAN_CONNECTION_SELECTORS = [
  "CONTAINER_CONNECTION",
  "CONTAINER_CERT_PATH",
  "CONTAINER_HOST",
  "CONTAINER_SSHKEY",
  "CONTAINER_TLS_VERIFY",
  "CONTAINERS_CONF",
  "CONTAINERS_STORAGE_CONF",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "PODMAN_CONNECTIONS_CONF",
  "REGISTRY_AUTH_FILE",
] as const;
const AUTHENTICATED_HEALTH_SCRIPT = String.raw`
import pathlib, re, urllib.error, urllib.request
text = pathlib.Path("/sandbox/.hermes/.env").read_text(encoding="utf-8")
matches = re.findall(r"^(?:export\s+)?API_SERVER_KEY=([0-9a-f]{64})$", text, re.MULTILINE)
if len(matches) != 1:
    raise SystemExit(2)
request = urllib.request.Request(
    "http://127.0.0.1:8642/health",
    headers={"Authorization": "Bearer " + matches[0]},
    method="GET",
)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise urllib.error.HTTPError(request.full_url, code, "redirect refused", headers, file_pointer)
try:
    response = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(
        request, timeout=5
    )
    print(response.status)
except urllib.error.HTTPError as error:
    print(error.code)
except urllib.error.URLError:
    print("unavailable")
`;

export interface HermesPortablePodmanResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface HermesPortablePodmanCapture {
  (args: readonly string[], timeoutMs: number): HermesPortablePodmanResult;
}

export interface HermesPortableAuthenticatedHealthCapture {
  (script: string, timeoutMs: number): HermesPortablePodmanResult;
}

export interface HermesPortableContainerInspection {
  readonly authority: HermesPortableContainerAuthority;
  readonly labels: Readonly<Record<string, string>>;
  readonly paused: boolean;
  readonly status: string;
}

export interface HermesPortableContainerDeps {
  readonly podman: HermesPortablePodmanCapture;
  readonly authenticatedHealth?: HermesPortableAuthenticatedHealthCapture;
  readonly socketAuthority?: PodmanSocketAuthorityDeps;
  readonly assertSocketAuthority?: typeof assertPodmanSocketAuthority;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
}

export type HermesPortableContainerStartResult = "already-running" | "started";
export type HermesPortableContainerStopResult = "already-stopped" | "stopped";

/** Bind schema-7 Podman to the receipt-owned current-user namespace. */
export function buildHermesPortablePodmanEnvironment(
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const expected = {
    HOME: runtimeAuthority.homeDir,
    XDG_CONFIG_HOME: runtimeAuthority.configHome,
    XDG_RUNTIME_DIR: runtimeAuthority.runtimeDir,
  } as const;
  for (const [name, value] of Object.entries(expected)) {
    const ambient = sourceEnv[name];
    if (ambient !== undefined && ambient !== "" && ambient !== value) {
      fail("Podman current-user namespace disagrees with receipt authority");
    }
  }
  for (const name of PODMAN_CONNECTION_SELECTORS) {
    if (sourceEnv[name]?.trim()) {
      fail("Podman connection selector is not allowed");
    }
  }
  return Object.freeze({ ...expected });
}

function fail(message: string): never {
  throw new Error(`Hermes portable container authority ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} is not a mapping`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 4096 ||
    value !== value.trim() ||
    (value.length > 0 && !SAFE.test(value))
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function fullId(value: unknown, label: string): string {
  const raw = text(value, label).toLowerCase();
  const normalized = raw.startsWith("sha256:") ? raw.slice(7) : raw;
  if (!FULL_ID.test(normalized)) fail(`${label} is not a full immutable ID`);
  return normalized;
}

function imageId(value: unknown): string {
  return `sha256:${fullId(value, "image ID")}`;
}

function labels(value: unknown): Readonly<Record<string, string>> {
  const input = record(value, "labels");
  const output: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(input)) {
    output[text(key, "label key")] = text(entry, `label '${key}'`, true);
  }
  return output;
}

function labelsDigest(value: Readonly<Record<string, string>>): string {
  const sorted = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function requireCommand(result: HermesPortablePodmanResult, operation: string): string {
  if (result.status === 0 && !result.error) return result.stdout;
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  fail(`${operation} failed with status ${String(result.status)}${code ? ` (${code})` : ""}`);
}

function isCommandTimeout(result: HermesPortablePodmanResult): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds);
}

function parseInspection(
  output: string,
  expected: {
    readonly sandboxName: string;
    readonly sandboxId: string;
    readonly containerId: string;
  },
): HermesPortableContainerInspection {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    fail("inspect returned malformed JSON");
  }
  if (!Array.isArray(decoded) || decoded.length !== 1)
    fail("inspect did not return exactly one row");
  const row = record(decoded[0], "inspect row");
  const containerId = fullId(row.Id, "container ID");
  if (containerId !== expected.containerId) fail("inspect returned another container ID");
  const config = record(row.Config, "inspect Config");
  const containerLabels = labels(config.Labels);
  const required = {
    [PODMAN_MANAGED_LABEL]: "true",
    [PODMAN_SANDBOX_ID_LABEL]: expected.sandboxId,
    [PODMAN_SANDBOX_NAME_LABEL]: expected.sandboxName,
    [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
    [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
  };
  for (const [key, value] of Object.entries(required)) {
    if (containerLabels[key] !== value) fail(`inspect label '${key}' disagrees with OpenShell`);
  }
  const expectedName = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${expected.sandboxName}-${expected.sandboxId}`;
  const name = text(row.Name, "container name");
  if (name !== expectedName) fail("inspect container name disagrees with OpenShell identity");
  const state = record(row.State, "inspect State");
  if (typeof state.Running !== "boolean" || typeof state.Status !== "string") {
    fail("inspect state is incomplete");
  }
  if (state.Paused !== undefined && typeof state.Paused !== "boolean") {
    fail("inspect paused state is invalid");
  }
  const hostConfig = record(row.HostConfig, "inspect HostConfig");
  const restart = record(hostConfig.RestartPolicy, "inspect restart policy");
  return {
    authority: {
      containerId,
      sandboxId: expected.sandboxId,
      imageId: imageId(row.Image),
      labelsSha256: labelsDigest(containerLabels),
      name,
      running: state.Running,
      restartPolicy: text(restart.Name, "restart policy", true),
    },
    labels: containerLabels,
    paused: state.Paused === true,
    status: text(state.Status, "container status").toLowerCase(),
  };
}

function assertSocket(
  receipt: HermesPortableLifecycleReceipt,
  deps: HermesPortableContainerDeps,
): void {
  (deps.assertSocketAuthority ?? assertPodmanSocketAuthority)(
    receipt.socketAuthority,
    deps.socketAuthority,
  );
}

function inspectExact(
  receipt: HermesPortableLifecycleReceipt,
  sandboxId: string,
  containerId: string,
  deps: HermesPortableContainerDeps,
): HermesPortableContainerInspection {
  assertSocket(receipt, deps);
  const output = requireCommand(
    deps.podman(["container", "inspect", containerId], INSPECT_TIMEOUT_MS),
    "exact inspect",
  );
  assertSocket(receipt, deps);
  return parseInspection(output, {
    sandboxName: receipt.sandboxName,
    sandboxId,
    containerId,
  });
}

/** Enroll exactly one live OpenShell-managed container after Ready. */
export function enrollHermesPortableContainer(
  receipt: HermesPortableLifecycleReceipt,
  sandboxId: string,
  deps: HermesPortableContainerDeps,
): HermesPortableContainerInspection {
  assertSocket(receipt, deps);
  const output = requireCommand(
    deps.podman(
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${PODMAN_MANAGED_LABEL}=true`,
        "--filter",
        `label=${PODMAN_SANDBOX_NAME_LABEL}=${receipt.sandboxName}`,
        "--filter",
        `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
        "--format",
        "{{.ID}}",
      ],
      INSPECT_TIMEOUT_MS,
    ),
    "container enrollment lookup",
  );
  assertSocket(receipt, deps);
  const ids = output
    .split(/\r?\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (ids.length !== 1 || !FULL_ID.test(ids[0]!)) {
    fail(`enrollment requires exactly one full container ID; found ${String(ids.length)}`);
  }
  const inspected = inspectExact(receipt, sandboxId, ids[0]!, deps);
  if (!inspected.authority.running || inspected.paused) {
    fail("enrollment requires the exact container to be running and unpaused");
  }
  return inspected;
}

/** Re-read one receipt-owned full ID and reject immutable identity drift. */
export function assertCurrentHermesPortableContainer(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableContainerDeps,
): HermesPortableContainerInspection {
  const inspected = inspectExact(
    receipt,
    receipt.container.sandboxId,
    receipt.container.containerId,
    deps,
  );
  const {
    restartPolicy: _recordedRestartPolicy,
    running: _recordedEnrollmentState,
    ...recorded
  } = receipt.container;
  const {
    restartPolicy: _currentRestartPolicy,
    running: _currentState,
    ...current
  } = inspected.authority;
  if (!isDeepStrictEqual(current, recorded)) fail("live immutable identity disagrees with receipt");
  return inspected;
}

/** Apply and verify the only enrollment-time Podman mutation by exact full ID. */
export function configureHermesPortableRestartPolicy(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableContainerDeps,
): HermesPortableContainerInspection {
  if (receipt.phase !== "configuring")
    fail("restart-policy configuration requires configuring authority");
  const before = assertCurrentHermesPortableContainer(receipt, deps);
  if (before.authority.restartPolicy !== "unless-stopped") {
    assertSocket(receipt, deps);
    requireCommand(
      deps.podman(
        ["container", "update", "--restart=unless-stopped", receipt.container.containerId],
        MUTATION_TIMEOUT_MS,
      ),
      "restart-policy update",
    );
    assertSocket(receipt, deps);
  }
  const after = assertCurrentHermesPortableContainer(receipt, deps);
  if (
    !after.authority.running ||
    after.paused ||
    after.authority.restartPolicy !== "unless-stopped"
  ) {
    fail("restart-policy configuration did not leave the exact container ready");
  }
  return after;
}

/** Read authenticated health without exposing the generated Bearer credential to the host. */
export function observeHermesPortableAuthenticatedHealth(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableContainerDeps,
): "ready" | "unavailable" {
  const before = assertCurrentHermesPortableContainer(receipt, deps);
  if (!before.authority.running || before.paused) {
    fail("authenticated health requires the exact container to be running and unpaused");
  }
  assertSocket(receipt, deps);
  if (!deps.authenticatedHealth) {
    fail("authenticated Hermes health observer is unavailable");
  }
  const output = requireCommand(
    deps.authenticatedHealth(AUTHENTICATED_HEALTH_SCRIPT, MUTATION_TIMEOUT_MS),
    "authenticated Hermes health probe",
  );
  assertSocket(receipt, deps);
  const status = output.trim();
  if (status !== String(receipt.startup.health.successStatus) && status !== "unavailable") {
    fail(`authenticated Hermes health returned status '${status || "missing"}'`);
  }
  const after = assertCurrentHermesPortableContainer(receipt, deps);
  if (!after.authority.running || after.paused) {
    fail("container authority changed during authenticated health");
  }
  return status === "unavailable" ? "unavailable" : "ready";
}

/** Prove Hermes' exact receipt-owned API accepts its generated Bearer credential. */
export function probeHermesPortableAuthenticatedHealth(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableContainerDeps,
): void {
  if (observeHermesPortableAuthenticatedHealth(receipt, deps) !== "ready") {
    fail("authenticated Hermes health is unavailable");
  }
}

/** Start only the receipt's exact full container ID and verify its immutable identity. */
export function startHermesPortableContainer(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableContainerDeps,
): HermesPortableContainerStartResult {
  if (receipt.phase !== "active") fail("start requires active receipt authority");
  const before = assertCurrentHermesPortableContainer(receipt, deps);
  if (before.paused) fail("start will not reinterpret a paused container");
  if (before.authority.running) return "already-running";
  assertSocket(receipt, deps);
  requireCommand(
    deps.podman(["container", "start", receipt.container.containerId], MUTATION_TIMEOUT_MS),
    "exact container start",
  );
  assertSocket(receipt, deps);
  const after = assertCurrentHermesPortableContainer(receipt, deps);
  if (!after.authority.running || after.paused) fail("exact container did not enter running state");
  return "started";
}

/** Stop one exact full ID; a timed-out client permits read-only reconciliation only. */
export function stopHermesPortableContainer(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableContainerDeps,
): HermesPortableContainerStopResult {
  if (receipt.phase !== "active") fail("stop requires active receipt authority");
  const before = assertCurrentHermesPortableContainer(receipt, deps);
  if (before.paused) fail("stop will not reinterpret a paused container");
  const settled = (inspection: HermesPortableContainerInspection): boolean => {
    if (inspection.paused) fail("container became paused while stopping");
    return !inspection.authority.running && inspection.status === "exited";
  };
  if (settled(before)) return "already-stopped";
  const waitForSettled = (): boolean => {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const deadline = now() + STOP_RECONCILIATION_TIMEOUT_MS;
    do {
      if (settled(assertCurrentHermesPortableContainer(receipt, deps))) return true;
      sleep(Math.min(STOP_RECONCILIATION_INTERVAL_MS, Math.max(1, deadline - now())));
    } while (now() < deadline);
    return settled(assertCurrentHermesPortableContainer(receipt, deps));
  };
  if (!before.authority.running) {
    if (waitForSettled()) return "stopped";
    fail("exact container did not settle in exited state");
  }
  assertSocket(receipt, deps);
  const result = deps.podman(
    ["container", "stop", receipt.container.containerId],
    MUTATION_TIMEOUT_MS,
  );
  assertSocket(receipt, deps);
  if (isCommandTimeout(result)) {
    if (waitForSettled()) return "stopped";
    requireCommand(result, "exact container stop");
  }
  requireCommand(result, "exact container stop");
  if (!waitForSettled()) fail("exact container did not settle in exited state");
  return "stopped";
}

export const hermesPortableContainerInternals = {
  authenticatedHealthScript: AUTHENTICATED_HEALTH_SCRIPT,
  labelsDigest,
  parseInspection,
};
