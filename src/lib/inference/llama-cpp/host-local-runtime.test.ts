// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildLlamaCppHostLocalDockerArgv,
  type LlamaCppHostLocalLaunchContract,
  type LlamaCppHostLocalRuntimeBindings,
} from "./host-local-runtime";

const MODEL_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"b".repeat(64)}`;

function contract(): LlamaCppHostLocalLaunchContract {
  return {
    model: {
      servedName: "nvidia-nemotron-3-nano-30b-a3b",
      file: {
        digest: MODEL_DIGEST,
        path: "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
        sizeBytes: 22_833_947_424,
      },
    },
    policy: {
      egress: "disabled",
      modelDownloads: "disabled",
      modelSource: "verified-local",
    },
    runtime: {
      gpu: { count: 1, cpuFallback: "reject", offload: "full", vendor: "nvidia" },
      resources: {
        memoryBytes: 51_539_607_552,
        pidsLimit: 256,
        writableStorageBytes: 42_949_672_960,
      },
    },
    serve: {
      authentication: "bearer",
      batchSize: 2_048,
      contextSize: 262_144,
      flashAttention: "enabled",
      idleSleepSeconds: -1,
      kvCache: { key: "f16", value: "f16" },
      limits: {
        requestTimeoutSeconds: 900,
      },
      microBatchSize: 512,
      port: 8_081,
      protocol: "openai-completions",
      slots: 1,
      speculativeDecoding: "disabled",
    },
    surfaces: {
      agentMode: "disabled",
      mcpProxy: "disabled",
      multimodalProjection: "disabled",
      router: "disabled",
      serverTools: "disabled",
      slotInspection: "disabled",
      ui: "disabled",
    },
  };
}

function bindings(): LlamaCppHostLocalRuntimeBindings {
  return {
    apiKeyHostPath: "/run/nemoclaw/llama-cpp/api-key",
    containerName: "nemoclaw-llama-cpp",
    imageReference: IMAGE,
    model: {
      digest: MODEL_DIGEST,
      hostPath: `/home/nvidia/.cache/huggingface/hub/blobs/${"c".repeat(64)}`,
      sizeBytes: 22_833_947_424,
    },
    network: { isolation: "docker-internal", name: "nemoclaw-llama-cpp-internal" },
    ownerLabel: { name: "io.nvidia.nemoclaw.llama-cpp-owner", value: "gateway.primary" },
    runtimeGid: 1_001,
    runtimeUid: 1_001,
  };
}

function valuesAfter(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((value, index) => (value === flag ? [argv[index + 1] ?? ""] : []));
}

describe("llama.cpp host-local runtime materializer", () => {
  it("binds the matching local GGUF into the declared llama.cpp runtime (#8144)", () => {
    const input = contract();
    const runtime = bindings();
    const argv = buildLlamaCppHostLocalDockerArgv(input, runtime);

    expect(valuesAfter(argv, "--mount")).toEqual([
      `type=bind,source=${runtime.model.hostPath},target=/models/${input.model.file.path},readonly`,
      `type=bind,source=${runtime.apiKeyHostPath},target=/run/secrets/llama-cpp-api-key,readonly`,
    ]);
    expect(valuesAfter(argv, "--publish")).toEqual(["127.0.0.1::8081"]);
    expect(valuesAfter(argv, "--gpus")).toEqual(["1"]);
    expect(valuesAfter(argv, "--gpu-layers")).toEqual(["all"]);
    expect(valuesAfter(argv, "--ctx-size")).toEqual([String(input.serve.contextSize)]);
    expect(valuesAfter(argv, "--batch-size")).toEqual([String(input.serve.batchSize)]);
    expect(valuesAfter(argv, "--ubatch-size")).toEqual([String(input.serve.microBatchSize)]);
    expect(valuesAfter(argv, "--timeout")).toEqual([
      String(input.serve.limits.requestTimeoutSeconds),
    ]);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--cap-drop",
        "ALL",
        "no-new-privileges=true",
        "--no-ui",
        "--no-slots",
        "--no-mmproj",
        "--no-agent",
      ]),
    );
    expect(argv.join("\n")).not.toContain("HF_TOKEN");
    expect(argv.join("\n")).not.toContain("huggingface.co");
  });

  it("takes launch settings from the declared contract instead of code defaults (#8144)", () => {
    const input = contract();
    const changed = {
      ...input,
      serve: {
        ...input.serve,
        batchSize: 1_024,
        contextSize: 131_072,
        limits: { ...input.serve.limits, requestTimeoutSeconds: 600 },
        microBatchSize: 256,
      },
    } satisfies LlamaCppHostLocalLaunchContract;
    const argv = buildLlamaCppHostLocalDockerArgv(changed, bindings());

    expect(valuesAfter(argv, "--ctx-size")).toEqual(["131072"]);
    expect(valuesAfter(argv, "--batch-size")).toEqual(["1024"]);
    expect(valuesAfter(argv, "--ubatch-size")).toEqual(["256"]);
    expect(valuesAfter(argv, "--timeout")).toEqual(["600"]);
  });

  it("materializes the complete Docker argument contract in stable order (#8144)", () => {
    const input = contract();
    const runtime = bindings();

    expect(buildLlamaCppHostLocalDockerArgv(input, runtime)).toEqual([
      "run",
      "--detach",
      "--name",
      runtime.containerName,
      "--label",
      `${runtime.ownerLabel.name}=${runtime.ownerLabel.value}`,
      "--network",
      runtime.network.name,
      "--user",
      "1001:1001",
      "--publish",
      "127.0.0.1::8081",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--memory",
      "51539607552b",
      "--memory-swap",
      "51539607552b",
      "--pids-limit",
      "256",
      "--gpus",
      "1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=42949672960,uid=1001,gid=1001,mode=1777",
      "--mount",
      `type=bind,source=${runtime.model.hostPath},target=/models/${input.model.file.path},readonly`,
      "--mount",
      `type=bind,source=${runtime.apiKeyHostPath},target=/run/secrets/llama-cpp-api-key,readonly`,
      runtime.imageReference,
      "--model",
      `/models/${input.model.file.path}`,
      "--alias",
      input.model.servedName,
      "--host",
      "0.0.0.0",
      "--port",
      "8081",
      "--gpu-layers",
      "all",
      "--ctx-size",
      "262144",
      "--parallel",
      "1",
      "--sleep-idle-seconds",
      "-1",
      "--batch-size",
      "2048",
      "--ubatch-size",
      "512",
      "--cache-type-k",
      "f16",
      "--cache-type-v",
      "f16",
      "--flash-attn",
      "on",
      "--timeout",
      "900",
      "--api-key-file",
      "/run/secrets/llama-cpp-api-key",
      "--metrics",
      "--no-ui",
      "--no-slots",
      "--no-mmproj",
      "--no-agent",
    ]);
  });

  it("rejects an artifact that does not match the declared GGUF identity (#8144)", () => {
    expect(() =>
      buildLlamaCppHostLocalDockerArgv(contract(), {
        ...bindings(),
        model: { ...bindings().model, digest: `sha256:${"0".repeat(64)}` },
      }),
    ).toThrow("verified model artifact does not match");
    expect(() =>
      buildLlamaCppHostLocalDockerArgv(contract(), {
        ...bindings(),
        model: { ...bindings().model, sizeBytes: 1 },
      }),
    ).toThrow("verified model artifact does not match");
  });

  it("rejects inputs that violate host-local isolation (#8144)", () => {
    expect(() =>
      buildLlamaCppHostLocalDockerArgv(contract(), {
        ...bindings(),
        model: { ...bindings().model, hostPath: "/models/../foreign.gguf" },
      }),
    ).toThrow("normalized absolute host path");
    expect(() =>
      buildLlamaCppHostLocalDockerArgv(contract(), {
        ...bindings(),
        network: { isolation: "docker-internal", name: "host" },
      }),
    ).toThrow("runtime binding is invalid");
    expect(() =>
      buildLlamaCppHostLocalDockerArgv(
        {
          ...contract(),
          policy: { ...contract().policy, egress: "enabled" },
        } as unknown as LlamaCppHostLocalLaunchContract,
        bindings(),
      ),
    ).toThrow("offline policy");
    expect(() =>
      buildLlamaCppHostLocalDockerArgv(
        {
          ...contract(),
          surfaces: { ...contract().surfaces, ui: "enabled" },
        } as unknown as LlamaCppHostLocalLaunchContract,
        bindings(),
      ),
    ).toThrow("disabled-surface contract");
  });
});
