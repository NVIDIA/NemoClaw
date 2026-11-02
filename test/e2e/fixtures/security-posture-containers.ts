// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeProviderCommandCapture,
  RuntimeProviderPrivilegedSandboxTarget,
} from "../../../src/lib/onboard/runtime-provider/contract.ts";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../src/lib/onboard/runtime-provider/current.ts";
import { requireRuntimeProviderBundleForSandbox } from "../../../src/lib/onboard/runtime-provider/selection.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import { OPENSHELL_V015_QUALIFICATION } from "./openshell-v0116-qualification.ts";

type Capture = (args: readonly string[]) => RuntimeProviderCommandCapture;
type Owner = { uid: number; gid: number };
type ContainerObservation = {
  id: string;
  image: string;
  startedAt: string;
  pid: number;
  user: string;
  entrypoint: string[];
  sandboxId: string;
  namespace: string;
};

export interface SecurityContainerPair {
  evidence: "container-launch-configuration-and-supervisor-health";
  workload: ContainerObservation;
  supervisor: ContainerObservation;
}

const FULL_ID = /^[a-f0-9]{64}$/u;

function requireObservation(condition: unknown): asserts condition {
  if (!condition) throw new Error("OpenShell container security observation failed");
}

function contentId(value: unknown): string {
  requireObservation(typeof value === "string");
  const id = value.replace(/^sha256:/u, "");
  requireObservation(FULL_ID.test(id));
  return id;
}

function captureJson(capture: Capture, args: readonly string[]): Record<string, unknown> {
  const result = capture(args);
  // Do not echo engine output: failures can contain unrelated container metadata.
  requireObservation(result.status === 0 && !result.error && result.stdout.length < 16_384);
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    requireObservation(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("OpenShell container security observation returned invalid metadata");
  }
}

function inspectFormat(provider: string, role: "sandbox" | "supervisor"): string {
  // Project only the required metadata. Never collect Env, health logs, auth mounts,
  // or supervisor arguments (which can contain proxy configuration).
  const fields: Record<string, string> = {
    id: ".Id",
    image: ".Image",
    user: ".Config.User",
    entrypoint: ".Config.Entrypoint",
    running: ".State.Running",
    paused: ".State.Paused",
    pid: ".State.Pid",
    startedAt: ".State.StartedAt",
    privileged: ".HostConfig.Privileged",
    capAdd: ".HostConfig.CapAdd",
    capDrop: ".HostConfig.CapDrop",
    securityOpt: ".HostConfig.SecurityOpt",
    network: ".HostConfig.NetworkMode",
    readonlyRootfs: ".HostConfig.ReadonlyRootfs",
    name: 'index .Config.Labels "openshell.ai/sandbox-name"',
    sandboxId: 'index .Config.Labels "openshell.ai/sandbox-id"',
    namespace: 'index .Config.Labels "openshell.ai/sandbox-namespace"',
    role: 'index .Config.Labels "openshell.ai/isolation-role"',
    managed:
      provider === "docker"
        ? 'index .Config.Labels "openshell.ai/managed-by"'
        : 'index .Config.Labels "openshell.managed"',
    ...(role === "sandbox" ? { command: ".Config.Cmd" } : {}),
    ...(provider === "podman"
      ? { effectiveCaps: ".EffectiveCaps", boundingCaps: ".BoundingCaps" }
      : {}),
  };
  return `{${Object.entries(fields)
    .map(([key, expression]) => `"${key}":{{json (${expression})}}`)
    .join(",")}}`;
}

function inspectContainer(
  capture: Capture,
  provider: string,
  id: string,
  sandboxName: string,
  role: "sandbox" | "supervisor",
  owner: Owner,
): ContainerObservation {
  requireObservation(FULL_ID.test(id));
  const record = captureJson(capture, [
    "container",
    "inspect",
    "--format",
    inspectFormat(provider, role),
    id,
  ]);
  const expectedUser =
    role === "supervisor" && provider === "docker" ? "65534:65534" : `${owner.uid}:${owner.gid}`;
  const executable =
    role === "supervisor"
      ? "/openshell-supervisor"
      : provider === "docker"
        ? "/.openshell/runtime/openshell-sandbox"
        : "/opt/openshell/bin/openshell-sandbox";
  requireObservation(
    record.id === id &&
      record.running === true &&
      record.paused === false &&
      Number.isSafeInteger(record.pid) &&
      Number(record.pid) > 0 &&
      typeof record.startedAt === "string" &&
      Number.isFinite(Date.parse(record.startedAt)) &&
      record.user === expectedUser &&
      JSON.stringify(record.entrypoint) === JSON.stringify([executable]) &&
      record.name === sandboxName &&
      record.role === role &&
      record.managed === (provider === "docker" ? "openshell" : "true") &&
      typeof record.sandboxId === "string" &&
      /^[a-zA-Z0-9_-]{1,128}$/u.test(record.sandboxId) &&
      typeof record.namespace === "string" &&
      record.namespace.length <= 128 &&
      record.privileged === false &&
      (record.capAdd === null || JSON.stringify(record.capAdd) === "[]") &&
      Array.isArray(record.capDrop) &&
      record.capDrop.length > 0 &&
      (provider === "docker"
        ? record.capDrop.includes("ALL")
        : record.effectiveCaps === null && record.boundingCaps === null) &&
      Array.isArray(record.securityOpt) &&
      record.securityOpt.some(
        (value) => value === "no-new-privileges" || value === "no-new-privileges:true",
      ) &&
      record.network === (role === "sandbox" ? "none" : "host") &&
      (role !== "supervisor" || provider !== "docker" || record.readonlyRootfs === true) &&
      (role !== "sandbox" ||
        JSON.stringify(record.command) ===
          JSON.stringify(["--bootstrap", "/.openshell/channel/sandbox/bootstrap.json"])),
  );
  return {
    id,
    image: contentId(record.image),
    startedAt: record.startedAt as string,
    pid: record.pid as number,
    user: expectedUser,
    entrypoint: [executable],
    sandboxId: record.sandboxId as string,
    namespace: record.namespace as string,
  };
}

/** Observe engine-owned launch configuration, not the bytes behind /proc/1/exe. */
export function observeSecurityContainerPair(
  capture: Capture,
  target: RuntimeProviderPrivilegedSandboxTarget,
  sandboxName: string,
  owner: Owner,
): SecurityContainerPair {
  const provider = target.providerId;
  requireObservation(provider === "docker" || provider === "podman");
  const workload = inspectContainer(
    capture,
    provider,
    target.resourceHandle,
    sandboxName,
    "sandbox",
    owner,
  );
  const discovered = capture([
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    `label=openshell.ai/sandbox-id=${workload.sandboxId}`,
    "--filter",
    "label=openshell.ai/isolation-role=supervisor",
    "--format",
    "{{.ID}}",
  ]);
  requireObservation(
    discovered.status === 0 && !discovered.error && discovered.stdout.length < 1024,
  );
  const supervisorId = discovered.stdout.trim();
  requireObservation(FULL_ID.test(supervisorId) && supervisorId !== workload.id);
  const supervisor = inspectContainer(
    capture,
    provider,
    supervisorId,
    sandboxName,
    "supervisor",
    owner,
  );
  requireObservation(
    supervisor.sandboxId === workload.sandboxId && supervisor.namespace === workload.namespace,
  );
  const image = captureJson(capture, [
    "image",
    "inspect",
    "--format",
    '{"id":{{json .Id}}}',
    OPENSHELL_V015_QUALIFICATION.supervisorImage,
  ]);
  requireObservation(supervisor.image === contentId(image.id));
  const socket =
    provider === "docker" ? "/run/openshell/health.sock" : "/run/openshell/supervisor-health.sock";
  const health = capture([
    "exec",
    supervisor.id,
    "/openshell-supervisor",
    "health",
    "--socket",
    socket,
  ]);
  requireObservation(health.status === 0 && !health.error);
  // Detect restart or replacement while the native health command ran.
  requireObservation(
    JSON.stringify(supervisor) ===
      JSON.stringify(
        inspectContainer(capture, provider, supervisor.id, sandboxName, "supervisor", owner),
      ),
  );
  requireObservation(
    JSON.stringify(workload) ===
      JSON.stringify(
        inspectContainer(capture, provider, workload.id, sandboxName, "sandbox", owner),
      ),
  );
  return { evidence: "container-launch-configuration-and-supervisor-health", workload, supervisor };
}

export function inspectSecurityContainerPair(
  sandboxName: string,
  target: RuntimeProviderPrivilegedSandboxTarget,
  owner: Owner,
): SecurityContainerPair {
  const sandbox = getSandbox(sandboxName);
  requireObservation(sandbox !== null);
  const provider = requireRuntimeProviderBundleForSandbox(
    sandbox,
    CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  const engine = provider.containerEngine;
  requireObservation(provider.identity.id === target.providerId && engine.supported);
  return observeSecurityContainerPair(
    (args) => engine.capture("sandbox-lifecycle", args, 30_000),
    target,
    sandboxName,
    owner,
  );
}
