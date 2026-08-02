// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { vi } from "vitest";

import type { ContainerEngine } from "../../src/lib/adapters/container-engine";
import type {
  HostLocalInferenceRouteAuthority,
  HostLocalInferenceRouteAuthorityStore,
  HostLocalManagedInferenceInput,
} from "../../src/lib/onboard/runtime-provider/host-local-inference";
import type {
  PersistedEngineAuthority,
  PersistedEngineAuthorityStore,
} from "../../src/lib/onboard/runtime-provider/persisted-engine-authority";
import {
  createPodmanHostLocalInferenceRuntime,
  PODMAN_INFERENCE_MANAGED_LABEL,
} from "../../src/lib/onboard/runtime-provider/podman-host-local-inference";
import type { PodmanHostPreflightReceipt } from "../../src/lib/onboard/runtime-provider/podman-preflight";

export const AUTHORITY_ID = "test:podman-inference";
export const BINDING_SHA256 = "a".repeat(64);
export const IMAGE_REF = `nvcr.io/nvidia/inference@sha256:${"b".repeat(64)}`;
export const PROBE_IMAGE_REF = `quay.io/curl/curl@sha256:${"c".repeat(64)}`;

export interface ContainerState {
  readonly id: string;
  readonly name: string;
  readonly imageRef: string;
  readonly labels: Record<string, string>;
  running: boolean;
  status: string;
}

export function memoryStore(): PersistedEngineAuthorityStore {
  let value: PersistedEngineAuthority | null = null;
  return {
    load: () => value,
    record: (authority) => {
      assert(
        value === null || JSON.stringify(value) === JSON.stringify(authority),
        "authority conflict",
      );
      value = authority;
      return authority;
    },
  };
}

export function memoryRouteAuthorityStore(): HostLocalInferenceRouteAuthorityStore {
  let value: HostLocalInferenceRouteAuthority | null = null;
  return {
    load: () => value,
    record: (authority) => {
      assert(
        value === null || JSON.stringify(value) === JSON.stringify(authority),
        "route authority conflict",
      );
      value = authority;
      return authority;
    },
  };
}

function preflight(authorityId = AUTHORITY_ID): PodmanHostPreflightReceipt {
  return {
    providerId: "podman",
    authorityId,
    clientVersion: "5.6.2",
    serverVersion: "5.6.2",
    rootless: true,
    cgroupVersion: "v2",
    os: "linux",
    architecture: "amd64",
    networkBackend: "netavark",
    cdiDevices: ["nvidia.com/gpu=all", "nvidia.com/gpu=0"],
  };
}

function optionValue(args: readonly string[], option: string): string {
  const index = args.indexOf(option);
  assert(index >= 0 && args[index + 1] !== undefined, `missing ${option}`);
  return String(args[index + 1]);
}

function optionValues(args: readonly string[], option: string): string[] {
  return args
    .map((value, index) => ({ index, value }))
    .filter(({ value }) => value === option)
    .map(({ index }) => optionValue(args.slice(index), option));
}

function labelsFromArgs(args: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    optionValues(args, "--label").map((label) => {
      const [key, ...value] = label.split("=");
      return [key, value.join("=")];
    }),
  );
}

function requireContainer(
  containers: ReadonlyMap<string, ContainerState>,
  id: string,
): ContainerState {
  const container = containers.get(id);
  assert(container, "container not found");
  return container;
}

function engineHarness(authorityId = AUTHORITY_ID) {
  const containers = new Map<string, ContainerState>();
  let counter = 1;
  let inspectImageOverride: string | null = null;
  let probeFailure: string | null = null;
  const capture = vi.fn((args: readonly string[]) => {
    switch (args[0]) {
      case "run": {
        switch (args.includes("--rm")) {
          case true:
            if (probeFailure !== null) {
              return { status: 22, stdout: "", stderr: probeFailure };
            }
            return { status: 0, stdout: "{}", stderr: "" };
          case false: {
            const id = counter.toString(16).padStart(64, "0");
            counter += 1;
            const imageRef = args.find((value) => value.includes("@sha256:")) ?? "";
            containers.set(id, {
              id,
              name: optionValue(args, "--name"),
              imageRef,
              labels: labelsFromArgs(args),
              running: true,
              status: "running",
            });
            return { status: 0, stdout: `${id}\n`, stderr: "" };
          }
        }
      }
      case "ps": {
        const filter = optionValue(args, "--filter");
        const name = filter.replace(/^name=\^/u, "").replace(/\$$/u, "");
        const matches = [...containers.values()].filter((container) => container.name === name);
        return {
          status: 0,
          stdout: matches.map((container) => `${container.id}\t${container.name}`).join("\n"),
          stderr: "",
        };
      }
      case "container": {
        assert.equal(args[1], "inspect", "unexpected container operation");
        const container = requireContainer(containers, String(args[2]));
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: container.id,
              Name: container.name,
              ImageName: inspectImageOverride ?? container.imageRef,
              Config: { Image: container.imageRef, Labels: container.labels },
              State: { Running: container.running, Status: container.status },
            },
          ]),
          stderr: "",
        };
      }
      case "start": {
        const container = requireContainer(containers, String(args[1]));
        container.running = true;
        container.status = "running";
        return { status: 0, stdout: container.id, stderr: "" };
      }
      case "stop": {
        const container = requireContainer(containers, String(args.at(-1)));
        container.running = false;
        container.status = "exited";
        return { status: 0, stdout: container.id, stderr: "" };
      }
      case "rm":
        containers.delete(String(args.at(-1)));
        return { status: 0, stdout: "", stderr: "" };
      default:
        return { status: 125, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    }
  });
  const engine: ContainerEngine = {
    operation: "host-local-inference",
    engineId: "podman",
    displayName: "Podman",
    authorityId,
    capture,
    captureHost: vi.fn(),
  };
  return {
    capture,
    containers,
    engine,
    setInspectImageOverride(value: string | null) {
      inspectImageOverride = value;
    },
    setProbeFailure(value: string | null) {
      probeFailure = value;
    },
  };
}

export function managedInput(service: "nim" | "vllm"): HostLocalManagedInferenceInput {
  return {
    service,
    containerName: `nemoclaw-${service}-alpha`,
    networkName: "openshell",
    hostPort: service === "nim" ? 8001 : 8002,
    containerPort: 8000,
    imageRef: IMAGE_REF,
    probeImageRef: PROBE_IMAGE_REF,
    gpuDevices: ["all"],
    environment: service === "nim" ? ["NIM_NGC_API_KEY", "NGC_API_KEY"] : ["HF_TOKEN"],
    mounts: [{ source: "/var/lib/nemoclaw/models", target: "/models", readOnly: true }],
    sharedMemory: "16g",
    ipc: "private",
    command: ["--model", service],
  };
}

export function runtimeHarness(
  authorityId = AUTHORITY_ID,
  store = memoryStore(),
  routeAuthorityStore = memoryRouteAuthorityStore(),
) {
  const host = engineHarness(authorityId);
  const runtime = createPodmanHostLocalInferenceRuntime({
    engine: host.engine,
    authorityStore: store,
    routeAuthorityStore,
    bindingSha256: BINDING_SHA256,
    preflight: preflight(authorityId),
  });
  return { ...host, routeAuthorityStore, runtime, store };
}

export function foreignContainer(id: string, name: string): ContainerState {
  return {
    id,
    name,
    imageRef: IMAGE_REF,
    labels: { [PODMAN_INFERENCE_MANAGED_LABEL]: "false" },
    running: true,
    status: "running",
  };
}
