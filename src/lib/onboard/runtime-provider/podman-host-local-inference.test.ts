// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AUTHORITY_ID,
  foreignContainer,
  IMAGE_REF,
  managedInput,
  memoryStore,
  PROBE_IMAGE_REF,
  runtimeHarness,
} from "./podman-host-local-inference-test-harness";

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
    expect(host.runtime).toMatchObject({ providerId: "podman", authorityId: AUTHORITY_ID });
    expect(host.runtime.preserveForRebuild(receipt)).toEqual(receipt);
    const probeUrls = host.capture.mock.calls
      .flatMap(([args]) => args)
      .filter((value) => URL.canParse(value))
      .map((value) => new URL(value));
    expect(
      probeUrls.map((url) => ({
        hash: url.hash,
        origin: url.origin,
        password: url.password,
        pathname: url.pathname,
        search: url.search,
        username: url.username,
      })),
    ).toEqual([
      {
        hash: "",
        origin: "http://host.containers.internal:11434",
        password: "",
        pathname: "/api/tags",
        search: "",
        username: "",
      },
      {
        hash: "",
        origin: "http://host.containers.internal:11434",
        password: "",
        pathname: "/api/tags",
        search: "",
        username: "",
      },
    ]);
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
    host.containers.set(foreignId, foreignContainer(foreignId, "nemoclaw-vllm-alpha"));
    expect(() => host.runtime.startManaged(managedInput("vllm"))).toThrow(
      "does not match its exact managed authority",
    );

    expect(() => host.runtime.startManaged({ ...managedInput("nim"), gpuDevices: ["1"] })).toThrow(
      "does not advertise",
    );
    expect(host.capture.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(0);
  });

  it("rejects a malformed mount flag instead of making an intended read-only mount writable", () => {
    const host = runtimeHarness();
    const input = {
      ...managedInput("vllm"),
      mounts: [
        {
          source: "/var/lib/nemoclaw/models",
          target: "/models",
          readOnly: "true" as unknown as boolean,
        },
      ],
    };

    expect(() => host.runtime.startManaged(input)).toThrow("read-only flag must be a boolean");
    expect(host.capture.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(0);
  });

  it("rejects a receipt whose host is a lookalike of the canonical provider endpoint", () => {
    const host = runtimeHarness();
    const receipt = host.runtime.qualifyOllama({
      networkName: "openshell",
      hostPort: 11434,
      probeImageRef: PROBE_IMAGE_REF,
    });
    const tampered = {
      ...receipt,
      endpoint: { ...receipt.endpoint, host: "host.containers.internal.attacker.example" },
    };
    const callsBeforeRejection = host.capture.mock.calls.length;

    expect(() => host.runtime.preserveForRebuild(tampered)).toThrow("canonical host");
    expect(host.capture).toHaveBeenCalledTimes(callsBeforeRejection);
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
