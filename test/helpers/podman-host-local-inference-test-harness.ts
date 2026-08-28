// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { ContainerEngineCommandResult } from "../../src/lib/adapters/container-engine";
import type { PodmanContainerEngine } from "../../src/lib/adapters/podman";
import type {
  HostLocalInferenceReceiptWriter,
  HostLocalInferenceRouteAuthority,
  HostLocalInferenceRouteAuthorityStore,
  HostLocalManagedInferenceInput,
  HostLocalOllamaAccelerationAuthority,
} from "../../src/lib/onboard/runtime-provider/host-local-inference";
import type {
  PersistedEngineAuthority,
  PersistedEngineAuthorityStore,
} from "../../src/lib/onboard/runtime-provider/persisted-engine-authority";
import {
  PODMAN_INFERENCE_AUTHORITY_LABEL,
  PODMAN_INFERENCE_MANAGED_LABEL,
  PODMAN_INFERENCE_NETWORK_ENGINE_AUTHORITY_LABEL,
  PODMAN_INFERENCE_NETWORK_MANAGED_LABEL,
  PODMAN_INFERENCE_NETWORK_PROVIDER_LABEL,
  PODMAN_INFERENCE_PRIOR_STATE_LABEL,
  PODMAN_INFERENCE_PROBE_MANAGED_LABEL,
  PODMAN_INFERENCE_PROBE_PHASE_LABEL,
  PODMAN_INFERENCE_PROBE_SPEC_LABEL,
  PODMAN_INFERENCE_PROVIDER_LABEL,
  PODMAN_INFERENCE_RECEIPT_TARGET_LABEL,
  PODMAN_INFERENCE_SERVICE_LABEL,
  PODMAN_INFERENCE_SPEC_LABEL,
  PODMAN_INFERENCE_TRANSACTION_LABEL,
  type PodmanInferenceFailureEvidence,
} from "../../src/lib/onboard/runtime-provider/podman-host-local-inference";
import { qualifyPodmanInferenceAuthority } from "../../src/lib/onboard/runtime-provider/podman-preflight";
import { redact, redactFull, redactSensitiveText } from "../../src/lib/security/redact";

const CONTAINER_ID = "a".repeat(64);
const REUSED_CONTAINER_ID = "b".repeat(64);
const PROBE_CONTAINER_ID = "c".repeat(64);
const REUSED_PROBE_CONTAINER_ID = "d".repeat(64);
const IMAGE_DIGEST = "1".repeat(64);
const PROBE_DIGEST = "2".repeat(64);
const TRANSACTION_ID = "3".repeat(64);
const TARGET_SHA256 = "4".repeat(64);
const GPU_UUID = "GPU-12345678-1234-1234-1234-123456789abc";

export function throwAfterPodmanEvent(
  events: readonly string[],
  fragment: string,
  message: string,
): void {
  if (events.some((event) => event.includes(fragment))) throw new Error(message);
}
const NETWORK_ID = "6".repeat(64);
const NETWORK_NAME = "nemoclaw-net";
const NETWORK_GATEWAY_IP = "10.89.0.1";
const NETWORK_SUBNET = "10.89.0.0/24";
const OLLAMA_MODEL_DIGEST = "7".repeat(64);
const OLLAMA_MODEL_SIZE = 8 * 1024 ** 3;

interface TestContainer {
  readonly id: string;
  readonly name: string;
  readonly imageRef: string;
  readonly labels: Record<string, string>;
  readonly createArguments: readonly string[];
  running: boolean;
  status: string;
  exitCode: number;
}

interface TestProbeContainer extends TestContainer {
  logsStdout: string;
  logsStderr: string;
}

export interface PodmanHostLocalInferenceHarnessOptions {
  readonly acceleration?: HostLocalOllamaAccelerationAuthority;
  readonly cdiDevices?: readonly string[];
  readonly omitDiscoveredDevices?: boolean;
  readonly gpuIdentities?: readonly string[];
  readonly authorityId?: string;
  readonly service?: "ollama" | "nim" | "vllm";
  readonly probeImageRef?: string;
}

export interface PodmanHostLocalInferenceHarness {
  readonly authorityStore: PersistedEngineAuthorityStore;
  readonly engine: PodmanContainerEngine;
  readonly env: NodeJS.ProcessEnv;
  readonly events: string[];
  readonly failures: PodmanInferenceFailureEvidence[];
  readonly failureProbeIds: Array<string | null>;
  readonly input: HostLocalManagedInferenceInput;
  readonly operationAcceleration: HostLocalOllamaAccelerationAuthority;
  readonly routeAuthorityStore: HostLocalInferenceRouteAuthorityStore;
  readonly writer: HostLocalInferenceReceiptWriter;
  readonly written: string[];
  readonly state: {
    cdiDevices: string[];
    omitDiscoveredDevices: boolean;
    driftAfterReady: boolean;
    driftAfterInference: boolean;
    gpuIdentities: string[];
    networkGatewayIp: string;
    networkId: string;
    networkName: string;
    probeFailure: "ready" | "gpu" | "inference" | null;
    probeFailureText: string;
    ollamaPullFailure: string | null;
    ollamaPsModels: unknown[];
    runLostAcknowledgement: boolean;
    runAcknowledgementText: string | null;
    startLostAcknowledgement: boolean;
    stopLostAcknowledgement: boolean;
    removeLostAcknowledgement: boolean;
    removeLeavesContainer: boolean;
    reuseNameAfterRemoval: boolean;
    runSemanticMismatchText: string | null;
    probeRunLostAcknowledgement: boolean;
    probeRunAcknowledgementText: string | null;
    probePostCreateNameLookupTimeout: boolean;
    probePostCreateInspectFailuresRemaining: number;
    probePostCreateInspectTimeoutsRemaining: number;
    probeInspectRuntimeIdMismatchAt: number | null;
    probeForbiddenActions: Array<"logs" | "rm" | "wait">;
    probeWaitTimeouts: number[];
    retainLegacyInferenceProbe: boolean;
    legacyInferenceProbeRunning: boolean;
    probeWaitFailure: boolean;
    probeRemoveLostAcknowledgement: boolean;
    probeRemoveLeavesContainer: boolean;
    probeReuseNameAfterRemoval: boolean;
    probeInheritedImageLabel: boolean;
    parentInheritedImageLabel: boolean;
    parentExtraControlledLabel: boolean;
    parentExitDuringProof: "ready" | "gpu" | "inference" | null;
    startLeavesContainerStopped: boolean;
    toolArguments: unknown;
    capturedEnvironmentValues: Readonly<Record<string, string>>[];
    writerFailuresRemaining: number;
  };
  readonly onFailureEvidence: (evidence: PodmanInferenceFailureEvidence) => void;
  readonly redactSensitive: (value: string) => string;
  readonly container: () => TestContainer | null;
  readonly probe: () => {
    readonly id: string;
    readonly name: string;
    readonly running: boolean;
    readonly status: string;
  } | null;
  readonly seedManaged: (
    priorState: "absent" | "running" | "stopped",
    running: boolean,
    engineBindingSha256: string,
  ) => void;
}

function result(status = 0, stdout = "", stderr = "", error?: Error): ContainerEngineCommandResult {
  return { status, stdout, stderr, ...(error ? { error } : {}) };
}

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`test command lacks ${flag}`);
  return String(args[index + 1]);
}

function labelsFrom(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const raw = String(args[index + 1]);
    const separator = raw.indexOf("=");
    labels[raw.slice(0, separator)] = raw.slice(separator + 1);
  }
  return labels;
}

function immutableManagedImage(args: readonly string[], probeImageRef: string): string {
  const imageRef = args.find((arg) => arg.includes("@sha256:") && arg !== probeImageRef);
  if (!imageRef) throw new Error("test harness expected an immutable managed image reference");
  return imageRef;
}

function inspectPayload(container: TestContainer): string {
  const environment = container.createArguments.flatMap((value, index, args) =>
    value === "--env" && typeof args[index + 1] === "string"
      ? [
          String(args[index + 1]) === "OLLAMA_CONTEXT_LENGTH"
            ? "OLLAMA_CONTEXT_LENGTH=64000"
            : String(args[index + 1]).includes("=")
              ? String(args[index + 1])
              : `${String(args[index + 1])}=injected-test-value`,
        ]
      : [],
  );
  const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = Object.create(null);
  for (let index = 0; index < container.createArguments.length; index += 1) {
    if (container.createArguments[index] !== "--publish") continue;
    const [hostIp, hostPort, containerPort] = String(
      container.createArguments[index + 1] ?? "",
    ).split(":");
    const key = `${containerPort}/tcp`;
    (portBindings[key] ??= []).push({ HostIp: hostIp ?? "", HostPort: hostPort ?? "" });
  }
  return JSON.stringify([
    {
      Id: container.id,
      Name: container.name,
      ImageName: container.imageRef,
      Config: {
        Image: container.imageRef,
        Labels: container.labels,
        CreateCommand: ["podman", ...container.createArguments],
        Env: environment,
      },
      State: {
        Running: container.running,
        Status: container.status,
        ExitCode: container.exitCode,
      },
      HostConfig: {
        NetworkMode: valueAfter(container.createArguments, "--network"),
        PortBindings: portBindings,
        RestartPolicy: { Name: valueAfter(container.createArguments, "--restart") },
        IpcMode: valueAfter(container.createArguments, "--ipc"),
        ShmSize: 64 * 1024 * 1024,
      },
      NetworkSettings: {
        Networks: {
          [valueAfter(container.createArguments, "--network")]: { NetworkID: NETWORK_ID },
        },
      },
      Mounts: [],
    },
  ]);
}

function probeInspectPayload(container: TestProbeContainer): string {
  return JSON.stringify([
    {
      Id: container.id,
      Name: container.name,
      ImageName: container.imageRef,
      Config: {
        Image: container.imageRef,
        Labels: container.labels,
        CreateCommand: ["podman", ...container.createArguments],
        Env: ["PATH=/usr/bin:/bin"],
      },
      State: {
        Running: container.running,
        Status: container.status,
        ExitCode: container.exitCode,
      },
      HostConfig: {
        NetworkMode: valueAfter(container.createArguments, "--network"),
        PortBindings: {},
        RestartPolicy: { Name: "no" },
        IpcMode: valueAfter(container.createArguments, "--ipc"),
      },
      NetworkSettings: {
        Networks: {
          [valueAfter(container.createArguments, "--network")]: { NetworkID: NETWORK_ID },
        },
      },
      Mounts: [],
    },
  ]);
}

interface ProbeWaitState {
  readonly parentExitDuringProof: "ready" | "gpu" | "inference" | null;
  readonly probeFailure: "ready" | "gpu" | "inference" | null;
  readonly probeFailureText: string;
  readonly ollamaPsModels: readonly unknown[];
  readonly probeWaitFailure: boolean;
  readonly toolArguments: unknown;
  readonly driftAfterReady: boolean;
  readonly driftAfterInference: boolean;
  cdiDevices: string[];
}

function completeProbeWait(
  probe: TestProbeContainer,
  parent: TestContainer | null,
  state: ProbeWaitState,
): ContainerEngineCommandResult {
  if (state.probeWaitFailure) {
    return result(125, "", "probe wait transport timeout", new Error("wait timeout"));
  }
  const url = String(probe.createArguments.at(-1));
  probe.running = false;
  probe.status = "exited";
  probe.exitCode = 0;
  if (url.includes("/api/tags")) {
    probe.logsStdout = JSON.stringify({ models: [] });
  } else if (url.includes("/api/ps")) {
    probe.logsStdout = JSON.stringify({ models: state.ollamaPsModels });
  } else if (url.includes("/v1/health/ready") || url.endsWith("/health")) {
    probe.logsStdout = "ready\n";
  } else if (url.includes("/v1/chat/completions")) {
    const body = JSON.parse(valueAfter(probe.createArguments, "--data-binary")) as {
      model: string;
      tool_choice?: string;
    };
    probe.logsStdout = JSON.stringify({
      model: body.model,
      choices: [
        {
          finish_reason: body.tool_choice === "required" ? "tool_calls" : "stop",
          message:
            body.tool_choice === "required"
              ? {
                  tool_calls: [
                    { function: { name: "nemoclaw_probe", arguments: state.toolArguments } },
                  ],
                }
              : { content: "provider-native completion" },
        },
      ],
    });
  } else {
    probe.exitCode = 22;
    probe.logsStderr = "unexpected probe URL";
  }
  const phase = url.includes("/v1/chat/completions")
    ? "inference"
    : url.includes("/api/ps")
      ? "gpu"
      : "ready";
  if (state.parentExitDuringProof === phase) {
    if (parent) {
      parent.running = false;
      parent.status = "exited";
      parent.exitCode = 1;
    }
    probe.exitCode = 22;
    probe.logsStdout = "";
    probe.logsStderr = state.probeFailureText;
  }
  if (state.probeFailure === phase) {
    probe.exitCode = 22;
    probe.logsStdout = "";
    probe.logsStderr = state.probeFailureText;
  }
  if (state.driftAfterReady && phase === "ready") state.cdiDevices = ["nvidia.com/gpu=0"];
  if (state.driftAfterInference && phase === "inference") {
    state.cdiDevices = ["nvidia.com/gpu=0"];
  }
  return result(0, `${String(probe.exitCode)}\n`);
}

function digest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function networkAuthoritySha256(engineAuthoritySha256: string): string {
  return digest({
    id: NETWORK_ID,
    name: NETWORK_NAME,
    driver: "bridge",
    internal: false,
    ipv6Enabled: false,
    dnsEnabled: true,
    networkInterface: "podman42",
    subnet: { subnet: NETWORK_SUBNET, gateway: NETWORK_GATEWAY_IP },
    labels: Object.fromEntries(
      [
        [PODMAN_INFERENCE_NETWORK_ENGINE_AUTHORITY_LABEL, engineAuthoritySha256],
        [PODMAN_INFERENCE_NETWORK_MANAGED_LABEL, "true"],
        [PODMAN_INFERENCE_NETWORK_PROVIDER_LABEL, "podman"],
      ].sort(([left], [right]) => left.localeCompare(right)),
    ),
    ipamOptions: { driver: "host-local" },
    options: {},
  });
}

function discoveredDevicesAuthority(state: {
  readonly cdiDevices: readonly string[];
  readonly omitDiscoveredDevices: boolean;
}): { readonly discoveredDevices?: readonly { readonly source: "cdi"; readonly id: string }[] } {
  return state.omitDiscoveredDevices
    ? {}
    : {
        discoveredDevices: state.cdiDevices.map((id) => ({ source: "cdi" as const, id })),
      };
}

export function createPodmanHostLocalInferenceTestHarness(
  options: PodmanHostLocalInferenceHarnessOptions = {},
): PodmanHostLocalInferenceHarness {
  const probeImageRef = options.probeImageRef ?? `registry.test/curl@sha256:${PROBE_DIGEST}`;
  const events: string[] = [];
  const failures: PodmanInferenceFailureEvidence[] = [];
  const failureProbeIds: Array<string | null> = [];
  const written: string[] = [];
  const state = {
    cdiDevices: [...(options.cdiDevices ?? [`nvidia.com/gpu=${GPU_UUID}`])],
    omitDiscoveredDevices: options.omitDiscoveredDevices ?? false,
    gpuIdentities: [...(options.gpuIdentities ?? [GPU_UUID])],
    networkGatewayIp: NETWORK_GATEWAY_IP,
    networkId: NETWORK_ID,
    networkName: NETWORK_NAME,
    probeFailure: null as "ready" | "gpu" | "inference" | null,
    probeFailureText:
      "provider\u0001failed\u0002 nvapi-1234567890abcdef Authorization: Bearer bearer-secret-1234 NGC_API_KEY=environment-secret https://user:pass@example.invalid/a?token=query-secret",
    ollamaPullFailure: null as string | null,
    ollamaPsModels: [
      {
        name: "nemotron:latest",
        model: "nemotron:latest",
        size: OLLAMA_MODEL_SIZE,
        size_vram: OLLAMA_MODEL_SIZE,
        digest: OLLAMA_MODEL_DIGEST,
      },
    ] as unknown[],
    driftAfterReady: false,
    driftAfterInference: false,
    runLostAcknowledgement: false,
    runAcknowledgementText: null as string | null,
    startLostAcknowledgement: false,
    stopLostAcknowledgement: false,
    removeLostAcknowledgement: false,
    removeLeavesContainer: false,
    reuseNameAfterRemoval: false,
    runSemanticMismatchText: null as string | null,
    probeRunLostAcknowledgement: false,
    probeRunAcknowledgementText: null as string | null,
    probePostCreateNameLookupTimeout: false,
    probePostCreateInspectFailuresRemaining: 0,
    probePostCreateInspectTimeoutsRemaining: 0,
    probeInspectRuntimeIdMismatchAt: null as number | null,
    probeForbiddenActions: [] as Array<"logs" | "rm" | "wait">,
    probeWaitTimeouts: [] as number[],
    retainLegacyInferenceProbe: false,
    legacyInferenceProbeRunning: false,
    probeWaitFailure: false,
    probeRemoveLostAcknowledgement: false,
    probeRemoveLeavesContainer: false,
    probeReuseNameAfterRemoval: false,
    probeInheritedImageLabel: false,
    parentInheritedImageLabel: false,
    parentExtraControlledLabel: false,
    parentExitDuringProof: null as "ready" | "gpu" | "inference" | null,
    startLeavesContainerStopped: false,
    toolArguments: "{}" as unknown,
    capturedEnvironmentValues: [] as Readonly<Record<string, string>>[],
    writerFailuresRemaining: 0,
  };
  let currentContainer: TestContainer | null = null;
  let currentProbe: TestProbeContainer | null = null;
  let probeInspectCount = 0;
  let networkEngineAuthoritySha256 = "";
  let persistedAuthority: PersistedEngineAuthority | null = null;
  let routeAuthority: HostLocalInferenceRouteAuthority | null = null;
  let retainedLegacyInferenceProbeForName = (_name: string): TestProbeContainer | null => null;

  const authorityStore: PersistedEngineAuthorityStore = {
    load: () => persistedAuthority,
    record: (authority) => {
      if (
        persistedAuthority !== null &&
        JSON.stringify(persistedAuthority) !== JSON.stringify(authority)
      ) {
        throw new Error("test authority store rejected replacement authority");
      }
      persistedAuthority = authority;
      return authority;
    },
  };
  const routeAuthorityStore: HostLocalInferenceRouteAuthorityStore = {
    load: () => routeAuthority,
    record: (authority) => {
      if (routeAuthority !== null && JSON.stringify(routeAuthority) !== JSON.stringify(authority)) {
        throw new Error("test route store rejected replacement authority");
      }
      routeAuthority = authority;
      events.push("route:record");
      return authority;
    },
  };
  const writer: HostLocalInferenceReceiptWriter = {
    transactionId: TRANSACTION_ID,
    targetSha256: TARGET_SHA256,
    writeExact: (serialized) => {
      events.push("receipt:write");
      if (state.writerFailuresRemaining > 0) {
        if (written.length === 0) written.push(serialized);
        state.writerFailuresRemaining -= 1;
        throw new Error("test receipt acknowledgement was lost");
      }
      if (written.length > 0 && written[0] !== serialized) {
        throw new Error("test writer rejected replacement receipt");
      }
      if (written.length === 0) written.push(serialized);
      return serialized;
    },
  };

  const engine: PodmanContainerEngine = {
    operation: "host-local-inference",
    engineId: "podman",
    displayName: "Podman",
    authorityId: options.authorityId ?? "test:podman-inference",
    endpointAuthorityId: options.authorityId ?? "test:podman-inference",
    capture: (args, timeoutMs) => {
      const probeAction =
        args[0] === "logs" || args[0] === "rm" || args[0] === "wait" ? args[0] : null;
      const probeActionId = probeAction === "rm" ? args.at(-1) : args[1];
      if (
        probeAction !== null &&
        state.probeForbiddenActions.includes(probeAction) &&
        (probeActionId === PROBE_CONTAINER_ID || probeActionId === REUSED_PROBE_CONTAINER_ID)
      ) {
        throw new Error(`test forbids probe action '${probeAction}'`);
      }
      events.push(`podman:${args.join(" ")}`);
      if (args[0] === "version") {
        return result(0, JSON.stringify({ Server: { Version: "6.0.1" } }));
      }
      if (args[0] === "info") {
        return result(
          0,
          JSON.stringify({
            host: {
              arch: "amd64",
              os: "linux",
              cgroupVersion: "v2",
              security: { rootless: true },
              ...discoveredDevicesAuthority(state),
            },
          }),
        );
      }
      if (args[0] === "network" && args[1] === "inspect") {
        if (args[2] !== NETWORK_ID || state.networkId !== NETWORK_ID) {
          return result(125, "", "no such network");
        }
        return result(
          0,
          JSON.stringify([
            {
              name: state.networkName,
              id: state.networkId,
              driver: "bridge",
              network_interface: "podman42",
              subnets: [{ subnet: NETWORK_SUBNET, gateway: state.networkGatewayIp }],
              ipv6_enabled: false,
              internal: false,
              dns_enabled: true,
              labels: {
                [PODMAN_INFERENCE_NETWORK_MANAGED_LABEL]: "true",
                [PODMAN_INFERENCE_NETWORK_PROVIDER_LABEL]: "podman",
                [PODMAN_INFERENCE_NETWORK_ENGINE_AUTHORITY_LABEL]: networkEngineAuthoritySha256,
              },
              ipam_options: { driver: "host-local" },
              options: {},
            },
          ]),
        );
      }
      if (args[0] === "ps") {
        const expectedName = String(args.find((arg) => arg.startsWith("name=^")) ?? "").slice(
          "name=^".length,
          -1,
        );
        let candidate = [currentContainer, currentProbe].find(
          (container) => container?.name === expectedName,
        );
        if (!candidate && state.retainLegacyInferenceProbe) {
          const retained = retainedLegacyInferenceProbeForName(expectedName);
          if (retained !== null) {
            currentProbe = retained;
            state.retainLegacyInferenceProbe = false;
            candidate = retained;
          }
        }
        if (
          state.probePostCreateNameLookupTimeout &&
          candidate === currentProbe &&
          currentProbe !== null
        ) {
          return result(1, "", "spawnSync /usr/local/bin/podman ETIMEDOUT", new Error("ETIMEDOUT"));
        }
        if (!candidate) return result();
        return result(0, `${candidate.id}\t${candidate.name}\n`);
      }
      if (args[0] === "container" && args[1] === "inspect") {
        if (currentContainer?.id === args[2]) return result(0, inspectPayload(currentContainer));
        if (currentProbe?.id === args[2]) {
          probeInspectCount += 1;
          if (state.probePostCreateInspectFailuresRemaining > 0) {
            state.probePostCreateInspectFailuresRemaining -= 1;
            const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
            return result(1, "", "permission denied", error);
          }
          if (state.probePostCreateInspectTimeoutsRemaining > 0) {
            state.probePostCreateInspectTimeoutsRemaining -= 1;
            const error = Object.assign(new Error("spawnSync /usr/local/bin/podman ETIMEDOUT"), {
              code: "ETIMEDOUT",
            });
            return result(1, "", "spawnSync /usr/local/bin/podman ETIMEDOUT", error);
          }
          const inspectedProbe =
            state.probeInspectRuntimeIdMismatchAt === probeInspectCount
              ? { ...currentProbe, id: REUSED_PROBE_CONTAINER_ID }
              : currentProbe;
          return result(0, probeInspectPayload(inspectedProbe));
        }
        return result(125, "", "no such container");
      }
      if (args[0] === "container" && args[1] === "exists") {
        return result(currentContainer?.id === args[2] || currentProbe?.id === args[2] ? 0 : 1);
      }
      if (args[0] === "run") {
        const name = valueAfter(args, "--name");
        const labels = labelsFrom(args);
        if (labels[PODMAN_INFERENCE_PROBE_MANAGED_LABEL] === "true") {
          if (state.probeInheritedImageLabel) {
            labels["org.opencontainers.image.source"] = "https://example.invalid/probe";
          }
          const imageRef = args.find((arg) => arg === probeImageRef) ?? "missing-probe-image";
          currentProbe = {
            id: PROBE_CONTAINER_ID,
            name,
            imageRef,
            labels,
            createArguments: Object.freeze([...args]),
            running: true,
            status: "running",
            exitCode: 0,
            logsStdout: "",
            logsStderr: "",
          };
          return state.probeRunLostAcknowledgement
            ? result(125, "", "transport closed after probe create")
            : result(0, state.probeRunAcknowledgementText ?? `${PROBE_CONTAINER_ID}\n`);
        }
        // Locate the immutable workload reference independent of optional flags.
        const immutableImage = immutableManagedImage(args, probeImageRef);
        if (state.parentInheritedImageLabel) {
          labels["org.opencontainers.image.source"] = "https://example.invalid/managed";
        }
        if (state.parentExtraControlledLabel) {
          labels[PODMAN_INFERENCE_PROBE_MANAGED_LABEL] = "true";
        }
        currentContainer = {
          id: CONTAINER_ID,
          name,
          imageRef: immutableImage,
          labels,
          createArguments: Object.freeze([...args]),
          running: state.runSemanticMismatchText === null,
          status: state.runSemanticMismatchText === null ? "running" : "exited",
          exitCode: state.runSemanticMismatchText === null ? 0 : 1,
        };
        if (state.runSemanticMismatchText !== null) {
          return result(0, `${CONTAINER_ID}\n`, state.runSemanticMismatchText);
        }
        return state.runLostAcknowledgement
          ? result(125, "", "transport closed after create")
          : result(0, state.runAcknowledgementText ?? `${CONTAINER_ID}\n`);
      }
      if (args[0] === "wait") {
        state.probeWaitTimeouts.push(timeoutMs ?? 0);
        if (!currentProbe || currentProbe.id !== args[1]) return result(125, "", "missing probe");
        return completeProbeWait(currentProbe, currentContainer, state);
      }
      if (args[0] === "logs") {
        if (!currentProbe || currentProbe.id !== args[1]) return result(125, "", "missing probe");
        return result(0, currentProbe.logsStdout, currentProbe.logsStderr);
      }
      if (args[0] === "exec") {
        if (args[2] === "ollama" && args[3] === "pull" && state.ollamaPullFailure !== null) {
          return result(1, "", state.ollamaPullFailure);
        }
        if (state.parentExitDuringProof === "gpu") {
          if (currentContainer) {
            currentContainer.running = false;
            currentContainer.status = "exited";
            currentContainer.exitCode = 1;
          }
          return result(1, "", state.probeFailureText);
        }
        if (state.probeFailure === "gpu") return result(1, "", state.probeFailureText);
        return result(0, `${state.gpuIdentities.join("\n")}\n`);
      }
      if (args[0] === "start") {
        if (!currentContainer || currentContainer.id !== args[1]) return result(125, "", "missing");
        if (!state.startLeavesContainerStopped) {
          currentContainer.running = true;
          currentContainer.status = "running";
        }
        return state.startLostAcknowledgement
          ? result(125, "", "transport closed after start")
          : result(0, `${currentContainer.id}\n`);
      }
      if (args[0] === "stop") {
        const probe = currentProbe;
        if (probe !== null && probe.id === args.at(-1)) {
          probe.running = false;
          probe.status = "exited";
          probe.exitCode = 137;
          return result(0, `${probe.id}\n`);
        }
        if (!currentContainer || currentContainer.id !== args.at(-1))
          return result(125, "", "missing");
        currentContainer.running = false;
        currentContainer.status = "exited";
        return state.stopLostAcknowledgement
          ? result(125, "", "transport closed after stop")
          : result(0, `${currentContainer.id}\n`);
      }
      if (args[0] === "rm") {
        const probe = currentProbe;
        if (probe !== null && probe.id === args.at(-1)) {
          const removedProbe = probe;
          if (!state.probeRemoveLeavesContainer) {
            currentProbe = state.probeReuseNameAfterRemoval
              ? {
                  ...removedProbe,
                  id: REUSED_PROBE_CONTAINER_ID,
                  labels: {},
                  running: true,
                  status: "running",
                  exitCode: 0,
                }
              : null;
          }
          return state.probeRemoveLostAcknowledgement
            ? result(125, "", "transport closed after probe remove")
            : result(0, `${PROBE_CONTAINER_ID}\n`);
        }
        if (!currentContainer || currentContainer.id !== args.at(-1))
          return result(125, "", "missing");
        const removedName = currentContainer.name;
        const removedImage = currentContainer.imageRef;
        if (!state.removeLeavesContainer) {
          currentContainer = state.reuseNameAfterRemoval
            ? {
                id: REUSED_CONTAINER_ID,
                name: removedName,
                imageRef: removedImage,
                labels: {},
                createArguments: currentContainer.createArguments,
                running: true,
                status: "running",
                exitCode: 0,
              }
            : null;
        }
        return state.removeLostAcknowledgement
          ? result(125, "", "transport closed after remove")
          : result(0, `${CONTAINER_ID}\n`);
      }
      return result(125, "", `unexpected test command: ${args.join(" ")}`);
    },
    captureHost: () => result(125, "", "host capture is forbidden"),
    captureWithEnvironment: (args, environment, timeoutMs, input) => {
      events.push(`environment:${Object.keys(environment).sort().join(",")}`);
      state.capturedEnvironmentValues.push(Object.freeze({ ...environment }));
      if (Object.values(environment).some((value) => value === "")) {
        return result(125, "", "empty secret environment");
      }
      return engine.capture(args, timeoutMs, input);
    },
  };

  networkEngineAuthoritySha256 = qualifyPodmanInferenceAuthority(engine).receiptSha256;
  events.length = 0;

  const service = options.service ?? "nim";
  const operationAcceleration = options.acceleration ?? "nvidia-gpu";
  const secretNames = service === "nim" ? ["NGC_API_KEY"] : [];
  const env = Object.fromEntries(secretNames.map((name) => [name, `test-${service}-secret`]));
  const input: HostLocalManagedInferenceInput = {
    service,
    containerName: `nemoclaw-${service}`,
    containerPort: 8000,
    imageRef: `registry.test/${service}@sha256:${IMAGE_DIGEST}`,
    gpuDevices: state.cdiDevices,
    networkName: NETWORK_NAME,
    networkId: NETWORK_ID,
    networkGatewayIp: NETWORK_GATEWAY_IP,
    hostPort: 18000,
    probeImageRef,
    model: `${service}-model`,
    requireToolCalling: true,
    environment: secretNames,
  };
  retainedLegacyInferenceProbeForName = (expectedName) => {
    if (currentContainer === null) return null;
    const parentAuthoritySha256 = currentContainer.labels[PODMAN_INFERENCE_AUTHORITY_LABEL];
    if (!parentAuthoritySha256) {
      throw new Error("test managed runtime lacks probe parent authority");
    }
    const endpoint = Object.freeze({
      host: "host.openshell.internal" as const,
      port: input.hostPort,
      networkName: input.networkName,
      networkId: input.networkId,
      networkGatewayIp: input.networkGatewayIp,
      networkAuthoritySha256: networkAuthoritySha256(networkEngineAuthoritySha256),
    });
    const body = JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: "Use the probe tool when it is available." }],
      max_tokens: 512,
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "nemoclaw_probe",
            description: "Return one host-local inference proof.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      ],
      tool_choice: "required",
    });
    const request = Object.freeze([
      "--header",
      "Content-Type: application/json",
      "--data-binary",
      body,
      `http://${input.networkGatewayIp}:${String(input.hostPort)}/v1/chat/completions`,
    ]);
    const specSha256 = digest({
      providerId: "podman",
      service: input.service,
      phase: "inference",
      endpoint,
      probeImageRef: input.probeImageRef,
      transactionId: writer.transactionId,
      receiptTargetSha256: writer.targetSha256,
      parentAuthoritySha256,
      request,
    });
    const name = `nemoclaw-inference-probe-inference-${specSha256.slice(0, 16)}`;
    if (name !== expectedName) return null;
    const labels = {
      [PODMAN_INFERENCE_PROBE_MANAGED_LABEL]: "true",
      [PODMAN_INFERENCE_PROVIDER_LABEL]: "podman",
      [PODMAN_INFERENCE_SERVICE_LABEL]: input.service,
      [PODMAN_INFERENCE_AUTHORITY_LABEL]: parentAuthoritySha256,
      [PODMAN_INFERENCE_TRANSACTION_LABEL]: writer.transactionId,
      [PODMAN_INFERENCE_RECEIPT_TARGET_LABEL]: writer.targetSha256,
      [PODMAN_INFERENCE_PROBE_PHASE_LABEL]: "inference",
      [PODMAN_INFERENCE_PROBE_SPEC_LABEL]: specSha256,
    };
    const running = state.legacyInferenceProbeRunning;
    return {
      id: PROBE_CONTAINER_ID,
      name,
      imageRef: input.probeImageRef,
      labels,
      createArguments: Object.freeze([
        "run",
        "--http-proxy=false",
        "--detach",
        "--pull",
        "never",
        "--name",
        name,
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        "--network",
        input.networkName,
        "--read-only",
        "--ipc",
        "private",
        input.probeImageRef,
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "3",
        "--max-time",
        "20",
        ...request,
      ]),
      running,
      status: running ? "running" : "exited",
      exitCode: running ? 0 : 28,
      logsStdout: "",
      logsStderr: running
        ? ""
        : "curl: (28) Operation timed out after 20002 milliseconds with 0 bytes received",
    };
  };
  return {
    authorityStore,
    engine,
    env,
    events,
    failures,
    failureProbeIds,
    input,
    operationAcceleration,
    routeAuthorityStore,
    writer,
    written,
    state,
    onFailureEvidence: (evidence) => {
      failureProbeIds.push(currentProbe?.id ?? null);
      events.push(`evidence:${evidence.phase}`);
      failures.push(evidence);
    },
    redactSensitive: (value) => redactSensitiveText(redactFull(redact(value))) ?? "<REDACTED>",
    container: () => currentContainer,
    probe: () => currentProbe,
    seedManaged: (priorState, running, engineBindingSha256) => {
      const gpuDevices = Object.freeze(
        [...input.gpuDevices]
          .map((device) =>
            device.startsWith("nvidia.com/gpu=") ? device : `nvidia.com/gpu=${device}`,
          )
          .sort(),
      );
      const endpoint = Object.freeze({
        host: "host.openshell.internal",
        port: input.hostPort,
        networkName: input.networkName,
        networkId: input.networkId,
        networkGatewayIp: input.networkGatewayIp,
        networkAuthoritySha256: networkAuthoritySha256(networkEngineAuthoritySha256),
      });
      const canonical = {
        service: input.service,
        containerName: input.containerName,
        containerPort: input.containerPort,
        imageRef: input.imageRef,
        gpuDevices,
        environment: Object.freeze([...(input.environment ?? [])].sort()),
        ollamaContextLength: input.ollamaContextLength ?? null,
        mounts: Object.freeze([]),
        sharedMemory: "64m",
        ipc: "private",
        command: Object.freeze([]),
        probeImageRef: input.probeImageRef,
        endpoint,
        model: input.model,
        requireToolCalling: input.requireToolCalling,
        transactionId: writer.transactionId,
        receiptTargetSha256: writer.targetSha256,
        priorState,
        engineBindingSha256,
      };
      const specSha256 = digest(canonical);
      const authoritySha256 = digest({
        providerId: "podman",
        service: input.service,
        endpoint,
        name: input.containerName,
        imageRef: input.imageRef,
        probeImageRef: input.probeImageRef,
        specSha256,
        gpu: { vendor: "nvidia", devices: gpuDevices },
        inference: {
          protocol: "openai-chat-completions",
          model: input.model,
          toolCallingRequired: input.requireToolCalling,
        },
        publication: {
          transactionId: writer.transactionId,
          targetSha256: writer.targetSha256,
          priorState,
        },
        engineBindingSha256,
      });
      currentContainer = {
        id: CONTAINER_ID,
        name: input.containerName,
        imageRef: input.imageRef,
        labels: {
          [PODMAN_INFERENCE_MANAGED_LABEL]: "true",
          [PODMAN_INFERENCE_PROVIDER_LABEL]: "podman",
          [PODMAN_INFERENCE_SERVICE_LABEL]: input.service,
          [PODMAN_INFERENCE_SPEC_LABEL]: specSha256,
          [PODMAN_INFERENCE_AUTHORITY_LABEL]: authoritySha256,
          [PODMAN_INFERENCE_TRANSACTION_LABEL]: writer.transactionId,
          [PODMAN_INFERENCE_RECEIPT_TARGET_LABEL]: writer.targetSha256,
          [PODMAN_INFERENCE_PRIOR_STATE_LABEL]: priorState,
        },
        createArguments: Object.freeze([
          "run",
          "--http-proxy=false",
          "--detach",
          "--pull",
          "never",
          "--init",
          "--restart",
          "unless-stopped",
          "--name",
          input.containerName,
          "--label",
          `${PODMAN_INFERENCE_MANAGED_LABEL}=true`,
          "--label",
          `${PODMAN_INFERENCE_PROVIDER_LABEL}=podman`,
          "--label",
          `${PODMAN_INFERENCE_SERVICE_LABEL}=${input.service}`,
          "--label",
          `${PODMAN_INFERENCE_SPEC_LABEL}=${specSha256}`,
          "--label",
          `${PODMAN_INFERENCE_AUTHORITY_LABEL}=${authoritySha256}`,
          "--label",
          `${PODMAN_INFERENCE_TRANSACTION_LABEL}=${writer.transactionId}`,
          "--label",
          `${PODMAN_INFERENCE_RECEIPT_TARGET_LABEL}=${writer.targetSha256}`,
          "--label",
          `${PODMAN_INFERENCE_PRIOR_STATE_LABEL}=${priorState}`,
          "--network",
          input.networkName,
          "--publish",
          `127.0.0.1:${String(input.hostPort)}:${String(input.containerPort)}`,
          "--publish",
          `${input.networkGatewayIp}:${String(input.hostPort)}:${String(input.containerPort)}`,
          ...gpuDevices.flatMap((device) => ["--device", device]),
          ...[...(input.environment ?? [])].flatMap((name) => ["--env", name]),
          ...(input.ollamaContextLength === undefined ? [] : ["--env", "OLLAMA_CONTEXT_LENGTH"]),
          "--shm-size",
          "64m",
          "--ipc",
          "private",
          input.imageRef,
          ...(input.command ?? []),
        ]),
        running,
        status: running ? "running" : "exited",
        exitCode: 0,
      };
    },
  };
}
