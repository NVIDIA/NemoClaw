// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import type { HostLocalManagedInferenceInput } from "./host-local-inference";
import type {
  PersistedEngineAuthority,
  PersistedEngineAuthorityStore,
} from "./persisted-engine-authority";
import {
  createPodmanHostLocalInferenceRuntime,
  PODMAN_INFERENCE_MANAGED_LABEL,
} from "./podman-host-local-inference";
import type { PodmanHostPreflightReceipt } from "./podman-preflight";

const AUTHORITY_ID = "test:podman-inference";
const BINDING_SHA256 = "a".repeat(64);
const IMAGE_REF = `nvcr.io/nvidia/inference@sha256:${"b".repeat(64)}`;
const PROBE_IMAGE_REF = `quay.io/curl/curl@sha256:${"c".repeat(64)}`;

interface ContainerState {
  readonly id: string;
  readonly name: string;
  readonly imageRef: string;
  readonly labels: Record<string, string>;
  running: boolean;
  status: string;
}

function memoryStore(): PersistedEngineAuthorityStore {
  let value: PersistedEngineAuthority | null = null;
  return {
    load: () => value,
    record: (authority) => {
      if (value && JSON.stringify(value) !== JSON.stringify(authority)) {
        throw new Error("authority conflict");
      }
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
  if (index < 0 || args[index + 1] === undefined) throw new Error(`missing ${option}`);
  return String(args[index + 1]);
}

function engineHarness(authorityId = AUTHORITY_ID) {
  const containers = new Map<string, ContainerState>();
  let counter = 1;
  let inspectImageOverride: string | null = null;
  const capture = vi.fn((args: readonly string[]) => {
    if (args[0] === "run" && args.includes("--rm")) {
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "run") {
      const id = counter.toString(16).padStart(64, "0");
      counter += 1;
      const imageRef = args.find((value) => value.includes("@sha256:")) ?? "";
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== "--label") continue;
        const [key, ...value] = String(args[index + 1]).split("=");
        labels[key] = value.join("=");
      }
      containers.set(id, {
        id,
        name: optionValue(args, "--name"),
        imageRef,
        labels,
        running: true,
        status: "running",
      });
      return { status: 0, stdout: `${id}\n`, stderr: "" };
    }
    if (args[0] === "ps") {
      const filter = optionValue(args, "--filter");
      const name = filter.replace(/^name=\^/u, "").replace(/\$$/u, "");
      const matches = [...containers.values()].filter((container) => container.name === name);
      return {
        status: 0,
        stdout: matches.map((container) => `${container.id}\t${container.name}`).join("\n"),
        stderr: "",
      };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const container = containers.get(String(args[2]));
      if (!container) return { status: 125, stdout: "", stderr: "not found" };
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
    if (args[0] === "start") {
      const container = containers.get(String(args[1]));
      if (!container) return { status: 125, stdout: "", stderr: "not found" };
      container.running = true;
      container.status = "running";
      return { status: 0, stdout: container.id, stderr: "" };
    }
    if (args[0] === "stop") {
      const container = containers.get(String(args.at(-1)));
      if (!container) return { status: 125, stdout: "", stderr: "not found" };
      container.running = false;
      container.status = "exited";
      return { status: 0, stdout: container.id, stderr: "" };
    }
    if (args[0] === "rm") {
      containers.delete(String(args.at(-1)));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 125, stdout: "", stderr: `unexpected ${args.join(" ")}` };
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
  };
}

function managedInput(service: "nim" | "vllm"): HostLocalManagedInferenceInput {
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

function runtimeHarness(authorityId = AUTHORITY_ID, store = memoryStore()) {
  const host = engineHarness(authorityId);
  const runtime = createPodmanHostLocalInferenceRuntime({
    engine: host.engine,
    authorityStore: store,
    bindingSha256: BINDING_SHA256,
    preflight: preflight(authorityId),
  });
  return { ...host, runtime, store };
}

describe("Podman host-local inference runtime", () => {
  it("qualifies and re-proves host Ollama through the exact runtime network", () => {
    const host = runtimeHarness();
    const receipt = host.runtime.qualifyOllama({
      networkName: "openshell",
      hostPort: 11434,
      probeImageRef: PROBE_IMAGE_REF,
    });

    expect(receipt).toMatchObject({
      providerId: "podman",
      service: "ollama",
      endpoint: { host: "host.containers.internal", port: 11434, networkName: "openshell" },
      runtime: { kind: "host", probeImageRef: PROBE_IMAGE_REF },
    });
    expect(host.runtime.preserveForRebuild(receipt)).toEqual(receipt);
    expect(
      host.capture.mock.calls.filter(([args]) =>
        args.includes("http://host.containers.internal:11434/api/tags"),
      ),
    ).toHaveLength(2);
    expect(host.runtime.translateContainerArgs(["--gpus", "all"])).toEqual([
      "--device",
      "nvidia.com/gpu=all",
    ]);
  });

  it.each([
    "nim",
    "vllm",
  ] as const)("starts, inspects, stops, and restarts exact managed %s authority", (service) => {
    const host = runtimeHarness();
    const input = managedInput(service);
    const receipt = host.runtime.startManaged(input);
    const run = host.capture.mock.calls.find(
      ([args]) => args[0] === "run" && !args.includes("--rm"),
    )?.[0];

    expect(receipt).toMatchObject({
      providerId: "podman",
      service,
      endpoint: { host: "host.containers.internal", port: input.hostPort },
      runtime: {
        kind: "container",
        name: input.containerName,
        imageRef: IMAGE_REF,
        gpu: { devices: ["nvidia.com/gpu=all"] },
      },
    });
    expect(run).toEqual(
      expect.arrayContaining([
        "--pull=never",
        "--device",
        "nvidia.com/gpu=all",
        "--publish",
        `127.0.0.1:${String(input.hostPort)}:8000`,
        "--shm-size",
        "16g",
      ]),
    );
    expect(run?.join(" ")).not.toContain("secret");
    expect(host.runtime.inspectManaged(receipt).running).toBe(true);
    expect(host.runtime.stopManaged(receipt).running).toBe(false);
    expect(host.runtime.startManaged(input)).toEqual(receipt);
    expect(host.runtime.preserveForRebuild(receipt)).toEqual(receipt);
    expect(host.capture.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(1);
    expect(host.capture.mock.calls.map(([args]) => args)).toContainEqual([
      "start",
      receipt.runtime.kind === "container" ? receipt.runtime.runtimeId : "unreachable",
    ]);
  });

  it("removes only a newly created container when exact post-start inspection fails", () => {
    const host = runtimeHarness();
    host.setInspectImageOverride(`nvcr.io/nvidia/other@sha256:${"d".repeat(64)}`);

    expect(() => host.runtime.startManaged(managedInput("vllm"))).toThrow(
      "does not match its exact managed authority",
    );
    expect(host.containers).toHaveLength(0);
    expect(
      host.capture.mock.calls.map(([args]) => args).some(([operation]) => operation === "rm"),
    ).toBe(true);
  });

  it("rejects foreign name ownership and unavailable CDI devices before mutation", () => {
    const host = runtimeHarness();
    const foreignId = "f".repeat(64);
    host.containers.set(foreignId, {
      id: foreignId,
      name: "nemoclaw-vllm-alpha",
      imageRef: IMAGE_REF,
      labels: { [PODMAN_INFERENCE_MANAGED_LABEL]: "false" },
      running: true,
      status: "running",
    });
    expect(() => host.runtime.startManaged(managedInput("vllm"))).toThrow(
      "does not match its exact managed authority",
    );

    expect(() => host.runtime.startManaged({ ...managedInput("nim"), gpuDevices: ["1"] })).toThrow(
      "does not advertise",
    );
    expect(host.capture.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(0);
  });

  it("rejects endpoint authority drift before receipt lifecycle commands", () => {
    const store = memoryStore();
    const original = runtimeHarness(AUTHORITY_ID, store);
    const receipt = original.runtime.startManaged(managedInput("nim"));
    const replacement = runtimeHarness("test:replacement", store);

    expect(() => replacement.runtime.inspectManaged(receipt)).toThrow(
      "endpoint does not match persisted authority",
    );
    expect(replacement.capture).not.toHaveBeenCalled();
  });
});
