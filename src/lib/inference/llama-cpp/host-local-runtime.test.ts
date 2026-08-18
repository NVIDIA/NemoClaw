// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LLAMA_CPP_PORT } from "./contract";
import {
  buildLlamaCppHostLocalDockerArgv,
  buildLlamaCppRequestGuardDockerArgv,
  LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH,
  LLAMA_CPP_HOST_LOCAL_SERVER_PATH,
  type LlamaCppHostLocalLaunchContract,
  type LlamaCppHostLocalRuntimeBindings,
} from "./host-local-runtime";

const MODEL_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"b".repeat(64)}`;
const MODEL_CONTENT = Buffer.alloc(64, 0x61);
const MODEL_FILENAME = "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
let modelRoot = "";
let modelPath = "";

function filesystemIdentity() {
  const status = lstatSync(modelPath, { bigint: true });
  return {
    ctimeNs: status.ctimeNs,
    dev: status.dev,
    ino: status.ino,
    mtimeNs: status.mtimeNs,
    size: status.size,
  };
}

beforeEach(() => {
  modelRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-runtime-")));
  modelPath = path.join(modelRoot, MODEL_FILENAME);
  writeFileSync(modelPath, MODEL_CONTENT);
});

afterEach(() => {
  rmSync(modelRoot, { force: true, recursive: true });
});

function contract(): LlamaCppHostLocalLaunchContract {
  return {
    model: {
      servedName: "nvidia-nemotron-3-nano-30b-a3b",
      file: {
        digest: MODEL_DIGEST,
        path: MODEL_FILENAME,
        sizeBytes: MODEL_CONTENT.length,
      },
    },
    policy: {
      egress: "disabled",
      modelDownloads: "disabled",
      modelSource: "verified-local",
    },
    runtime: {
      restartPolicy: "unless-stopped",
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
      chatTemplate: "nemotron-v3-embedded",
      contextSize: 262_144,
      flashAttention: "enabled",
      idleSleepSeconds: -1,
      kvCache: { key: "f16", value: "f16" },
      limits: {
        maxRequestBodyBytes: 1_048_576,
        maxRequestHeaderBytes: 32_768,
        maxOutputTokens: 4_096,
        requestTimeoutSeconds: 900,
        shutdownTimeoutSeconds: 25,
      },
      requestGuard: { upstreamPort: 8_082 },
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
      filesystemIdentity: filesystemIdentity(),
      hostPath: modelPath,
      sizeBytes: MODEL_CONTENT.length,
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
    expect(valuesAfter(argv, "--publish")).toEqual([]);
    expect(valuesAfter(argv, "--gpus")).toEqual(["driver=nvidia,count=1"]);
    expect(valuesAfter(argv, "--gpu-layers")).toEqual(["all"]);
    expect(valuesAfter(argv, "--ctx-size")).toEqual([String(input.serve.contextSize)]);
    expect(valuesAfter(argv, "--batch-size")).toEqual([String(input.serve.batchSize)]);
    expect(valuesAfter(argv, "--ubatch-size")).toEqual([String(input.serve.microBatchSize)]);
    expect(valuesAfter(argv, "--timeout")).toEqual([
      String(input.serve.limits.requestTimeoutSeconds),
    ]);
    expect(argv).not.toContain("--n-predict");
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

  it("leaves fixed host-port bridging to the Docker lifecycle provider", () => {
    const argv = buildLlamaCppHostLocalDockerArgv(contract(), {
      ...bindings(),
      hostPort: LLAMA_CPP_PORT,
    });

    expect(valuesAfter(argv, "--publish")).toEqual([]);
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

  it.each([{ scenario: "host-local runtime" }, { scenario: "request guard" }])(
    "materializes a declared container chat template and reasoning contract [$scenario]",
    ({ scenario }) => {
      const input = contract();
      const templated = {
        ...input,
        serve: {
          ...input.serve,
          chatTemplate: "container-jinja-file",
          chatTemplateFile:
            "/usr/local/share/nemoclaw/llama-cpp/chat-templates/model-canonical.jinja",
          reasoning: { format: "deepseek", mode: "auto" },
        },
      } satisfies LlamaCppHostLocalLaunchContract;

      const argv = (
        {
          "host-local runtime": buildLlamaCppHostLocalDockerArgv(templated, bindings()),
          "request guard": buildLlamaCppRequestGuardDockerArgv(templated, bindings()),
        } as const
      )[scenario]!;
      expect(valuesAfter(argv, "--chat-template-file")).toEqual([
        "/usr/local/share/nemoclaw/llama-cpp/chat-templates/model-canonical.jinja",
      ]);
      expect(valuesAfter(argv, "--reasoning-format")).toEqual(["deepseek"]);
      expect(valuesAfter(argv, "--reasoning")).toEqual(["auto"]);
      expect(argv).toContain("--jinja");
    },
  );

  it.each([{ scenario: "host-local runtime" }, { scenario: "request guard" }])(
    "materializes a model-embedded Jinja template with typed Muse reasoning strength [$scenario]",
    ({ scenario }) => {
      const input = contract();
      const templated = {
        ...input,
        serve: {
          ...input.serve,
          chatTemplate: "model-embedded-jinja",
          chatTemplateArguments: { reasoningStrength: "low" },
        },
      } satisfies LlamaCppHostLocalLaunchContract;

      const argv = (
        {
          "host-local runtime": buildLlamaCppHostLocalDockerArgv(templated, bindings()),
          "request guard": buildLlamaCppRequestGuardDockerArgv(templated, bindings()),
        } as const
      )[scenario]!;
      expect(argv).toContain("--jinja");
      expect(valuesAfter(argv, "--chat-template-kwargs")).toEqual(['{"reasoning_strength":"low"}']);
      expect(argv).not.toContain("--chat-template-file");
      expect(argv).not.toContain("--reasoning-format");
    },
  );

  it.each([
    ["a missing container template file", { chatTemplate: "container-jinja-file" }],
    [
      "a path outside the owned template directory",
      { chatTemplate: "container-jinja-file", chatTemplateFile: "/run/secrets/template.jinja" },
    ],
    [
      "a traversing container template path",
      {
        chatTemplate: "container-jinja-file",
        chatTemplateFile:
          "/usr/local/share/nemoclaw/llama-cpp/chat-templates/../private/template.jinja",
      },
    ],
    [
      "an external template on the embedded-template contract",
      {
        chatTemplate: "nemotron-v3-embedded",
        chatTemplateFile:
          "/usr/local/share/nemoclaw/llama-cpp/chat-templates/model-canonical.jinja",
      },
    ],
    [
      "reasoning on the embedded-template contract",
      {
        chatTemplate: "nemotron-v3-embedded",
        reasoning: { format: "deepseek", mode: "auto" },
      },
    ],
    [
      "missing arguments on the model-embedded Jinja contract",
      { chatTemplate: "model-embedded-jinja" },
    ],
    [
      "null arguments on the model-embedded Jinja contract",
      { chatTemplate: "model-embedded-jinja", chatTemplateArguments: null },
    ],
    [
      "an unsupported reasoning strength",
      {
        chatTemplate: "model-embedded-jinja",
        chatTemplateArguments: { reasoningStrength: "maximum" },
      },
    ],
    [
      "extra model-embedded Jinja arguments",
      {
        chatTemplate: "model-embedded-jinja",
        chatTemplateArguments: { reasoningStrength: "low", untrusted: "value" },
      },
    ],
  ])("rejects %s", (_case, serveOverrides) => {
    const input = contract();
    const invalid = {
      ...input,
      serve: { ...input.serve, ...serveOverrides },
    } as unknown as LlamaCppHostLocalLaunchContract;

    expect(() => buildLlamaCppHostLocalDockerArgv(invalid, bindings())).toThrow(
      "chat-template or reasoning contract is invalid",
    );
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
      "--restart",
      "unless-stopped",
      "--user",
      "1001:1001",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--no-healthcheck",
      "--memory",
      "51539607552b",
      "--memory-swap",
      "51539607552b",
      "--pids-limit",
      "256",
      "--gpus",
      "driver=nvidia,count=1",
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

  it("activates the owned-image request guard from the declared recipe values (#8144)", () => {
    const input = contract();
    const runtime = bindings();
    const argv = buildLlamaCppRequestGuardDockerArgv(input, runtime);
    const separator = argv.indexOf("--");

    expect(valuesAfter(argv, "--publish")).toEqual([]);
    expect(argv).toContain("--no-healthcheck");
    expect(valuesAfter(argv, "--entrypoint")).toEqual([LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH]);
    expect(valuesAfter(argv, "--listen-port")).toEqual([String(input.serve.port)]);
    expect(valuesAfter(argv, "--upstream-port")).toEqual([
      String(input.serve.requestGuard.upstreamPort),
    ]);
    expect(valuesAfter(argv, "--max-request-body-bytes")).toEqual([
      String(input.serve.limits.maxRequestBodyBytes),
    ]);
    expect(valuesAfter(argv, "--max-request-header-bytes")).toEqual([
      String(input.serve.limits.maxRequestHeaderBytes),
    ]);
    expect(valuesAfter(argv, "--max-output-tokens")).toEqual([
      String(input.serve.limits.maxOutputTokens),
    ]);
    expect(valuesAfter(argv, "--request-timeout-seconds")).toEqual([
      String(input.serve.limits.requestTimeoutSeconds),
    ]);
    expect(valuesAfter(argv, "--shutdown-timeout-seconds")).toEqual([
      String(input.serve.limits.shutdownTimeoutSeconds),
    ]);
    expect(argv.slice(separator + 1, separator + 8)).toEqual([
      LLAMA_CPP_HOST_LOCAL_SERVER_PATH,
      "--model",
      `/models/${input.model.file.path}`,
      "--alias",
      input.model.servedName,
      "--host",
      "127.0.0.1",
    ]);
    expect(valuesAfter(argv.slice(separator), "--port")).toEqual([
      String(input.serve.requestGuard.upstreamPort),
    ]);
    expect(valuesAfter(argv.slice(separator), "--n-predict")).toEqual([
      String(input.serve.limits.maxOutputTokens),
    ]);
  });

  it("keeps the upstream-image launch on the llama-server entrypoint (#8144)", () => {
    const argv = buildLlamaCppHostLocalDockerArgv(contract(), bindings());

    expect(argv).not.toContain("--entrypoint");
    expect(argv).not.toContain(LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH);
    expect(argv).not.toContain("--n-predict");
    expect(valuesAfter(argv, "--host")).toEqual(["0.0.0.0"]);
    expect(valuesAfter(argv, "--port")).toEqual(["8081"]);
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

  it("rejects a replacement at a previously verified model path (#8279)", () => {
    const runtime = bindings();
    renameSync(modelPath, `${modelPath}.verified`);
    writeFileSync(modelPath, MODEL_CONTENT);

    expect(() => buildLlamaCppHostLocalDockerArgv(contract(), runtime)).toThrow(
      "does not match its verified filesystem identity",
    );
  });

  it("rejects changed state on the previously verified inode (#8279)", () => {
    const runtime = bindings();
    writeFileSync(modelPath, Buffer.alloc(MODEL_CONTENT.length, 0x62));
    const future = new Date(Date.now() + 10_000);
    utimesSync(modelPath, future, future);

    expect(() => buildLlamaCppHostLocalDockerArgv(contract(), runtime)).toThrow(
      "does not match its verified filesystem identity",
    );
  });

  it.each(["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)(
    "rejects a forged %s field in the verified filesystem identity (#8279)",
    (field) => {
      const runtime = bindings();
      expect(() =>
        buildLlamaCppHostLocalDockerArgv(contract(), {
          ...runtime,
          model: {
            ...runtime.model,
            filesystemIdentity: {
              ...runtime.model.filesystemIdentity,
              [field]: runtime.model.filesystemIdentity[field] + 1n,
            },
          },
        }),
      ).toThrow("does not match its verified filesystem identity");
    },
  );

  it("rejects a forged artifact that omits filesystem identity (#8279)", () => {
    const runtime = bindings();
    expect(() =>
      buildLlamaCppHostLocalDockerArgv(contract(), {
        ...runtime,
        model: {
          ...runtime.model,
          filesystemIdentity: undefined,
        } as unknown as typeof runtime.model,
      }),
    ).toThrow("does not match its verified filesystem identity");
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
