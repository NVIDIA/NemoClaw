// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { vllmProbePolicyForModel } from "./openai-probe-models";
import { loadManagedInferenceCatalog } from "./serving/catalog-loader";
import type { HostLocalInferenceServingRecipe, ServingModelPreparation } from "./serving/types";
import { detectVllmProfile, resolveVllmModelRuntime } from "./vllm";
import {
  assertGatedModelAccess,
  buildNemotronUltraDistributedServeCommand,
  buildVllmServeCommand,
  defaultVllmModelForPlatform,
  DEFAULT_VLLM_MODEL,
  modelsForPlatform,
  parseVllmExtraServeArgs,
  preflightVllmModelEnv,
  resolveVllmGpuMemoryUtilization,
  selectVllmModelFromEnv,
  STATION_PAIR_OPTIONAL_ORCHESTRATION,
  VLLM_EXTRA_ARGS_ENV,
  VLLM_MODELS,
  vllmModelsFromCatalog,
  vllmModelForOrchestration,
} from "./vllm-models";

describe("vllm model registry", () => {
  it("maps every generated runtime variant to a compiled catalog preset", () => {
    const catalog = loadManagedInferenceCatalog();
    const presetIds = new Set(catalog.presets.map(({ metadata }) => metadata.id));
    const runtimeVariants = VLLM_MODELS.flatMap((model) => model.runtimeVariants ?? []);
    const runtimePresetIds = runtimeVariants.map(({ catalogPresetId }) => catalogPresetId);

    expect(runtimeVariants.length).toBeGreaterThan(0);
    expect(runtimePresetIds.filter((presetId) => !presetIds.has(presetId!))).toEqual([]);
    expect(new Set(runtimePresetIds).size).toBe(runtimeVariants.length);
    expect(new Set(VLLM_MODELS.map((model) => model.envValue)).size).toBe(VLLM_MODELS.length);
  });

  it.each(VLLM_MODELS)("derives capabilities and probe policy for $envValue", (model) => {
    expect(model.capabilities).toMatchObject({
      chatCompletions: true,
      toolCalls: true,
    });
    expect(model.probePolicyRef).toMatch(/^nvidia\.endpoint-validation\./u);
    expect(model.runtimeVariants?.length).toBeGreaterThan(0);
  });

  it.each(
    VLLM_MODELS.flatMap((model) =>
      (model.runtimeVariants ?? []).map((variant) => [model.envValue, variant] as const),
    ),
  )("derives a qualified catalog runtime for %s [case %#]", (_model, variant) => {
    expect(variant.catalogPresetId).toMatch(/^vllm\./u);
    expect(variant.platforms).toHaveLength(1);
    expect(variant.architectures).toHaveLength(1);
  });

  it("discovers special orchestration and probe behavior through catalog references", () => {
    const stationPairModel = vllmModelForOrchestration(
      STATION_PAIR_OPTIONAL_ORCHESTRATION,
      "station",
      "arm64",
    );

    expect(stationPairModel?.runtimeVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orchestrationRef: STATION_PAIR_OPTIONAL_ORCHESTRATION,
          stationPair: expect.objectContaining({
            nodeCount: 2,
            pipelineParallelSize: 2,
          }),
        }),
      ]),
    );
    expect(vllmProbePolicyForModel("deepseek-ai/deepseek-v4-flash")).toBe(
      "nvidia.endpoint-validation.extended/v1",
    );
    expect(vllmProbePolicyForModel("unknown/model")).toBe("nvidia.endpoint-validation.standard/v1");
  });

  it("adds a model through catalog data without a TypeScript registry edit", () => {
    const catalog = loadManagedInferenceCatalog();
    const sourceRecipe = catalog.recipes.find(
      ({ metadata }) => metadata.id === "vllm.nemotron-3-nano-4b-fp8.linux-amd64-single.v1",
    ) as HostLocalInferenceServingRecipe;
    const sourcePreset = catalog.presets.find(
      ({ spec }) => spec.plan.recipeRef === sourceRecipe.metadata.id,
    )!;
    const recipeId = "vllm.catalog-only-test-model.linux-amd64-single.v1";
    const addedRecipe: HostLocalInferenceServingRecipe = {
      ...sourceRecipe,
      metadata: {
        ...sourceRecipe.metadata,
        id: recipeId,
        displayName: "Catalog-only test model",
      },
      spec: {
        ...sourceRecipe.spec,
        model: {
          ...sourceRecipe.spec.model,
          id: "test/catalog-only-model",
          environmentValue: "catalog-only-model",
          displayName: "Catalog-only model",
          menuOrder: 999,
          servedName: "catalog-only-model",
        },
        readiness: {
          ...sourceRecipe.spec.readiness,
          expectedModel: "catalog-only-model",
        },
      },
    };
    const addedPreset = {
      ...sourcePreset,
      metadata: {
        ...sourcePreset.metadata,
        id: "vllm.linux-amd64-nvidia.single.catalog-only-test-model",
        displayName: "Catalog-only test model on Linux x86_64",
      },
      spec: {
        ...sourcePreset.spec,
        selection: "explicit-only" as const,
        plan: { ...sourcePreset.spec.plan, recipeRef: recipeId },
      },
    };

    const models = vllmModelsFromCatalog({
      ...catalog,
      recipes: [...catalog.recipes, addedRecipe],
      presets: [...catalog.presets, addedPreset],
    });

    expect(models.find(({ envValue }) => envValue === "catalog-only-model")).toMatchObject({
      id: "test/catalog-only-model",
      label: "Catalog-only model",
      platforms: ["linux"],
      requireRuntimeVariant: true,
    });
  });

  it.each([
    ["spark", "arm64", "qwen3.6-35b-a3b-nvfp4"],
    ["station", "arm64", "deepseek-v4-flash"],
    ["n1x", "arm64", "qwen3.6-35b-a3b-nvfp4"],
    ["linux", "x64", "nemotron-3-nano-4b"],
    ["linux", "arm64", "nemotron-3-nano-4b"],
  ] as const)("selects the catalog default for %s/%s", (platform, architecture, expected) => {
    expect(defaultVllmModelForPlatform(platform, architecture).envValue).toBe(expected);
  });

  it("starts directly with setup when the serving environment is empty (#8246)", () => {
    const command = buildVllmServeCommand({
      id: "test/model",
      label: "Test model",
      envValue: "test-model",
      downloadSizeBytes: 1,
      maxModelLen: 4096,
      modelArgs: [],
      gated: false,
      platforms: ["spark"],
      serveEnv: {},
    });

    expect(command).toMatch(/^pip install vllm\[fastsafetensors\] && vllm serve/u);
  });

  it.each(VLLM_MODELS)(
    "records a finite positive Hugging Face file size for every model [case %#]",
    (model) => {
      expect(Number.isFinite(model.downloadSizeBytes)).toBe(true);
      expect(model.downloadSizeBytes).toBeGreaterThan(0);
    },
  );

  it("pins the Hugging Face repository file totals used by storage preflight (#6858)", () => {
    expect(
      Object.fromEntries(VLLM_MODELS.map((model) => [model.envValue, model.downloadSizeBytes])),
    ).toEqual({
      "qwen3.6-27b": 30_900_000_000,
      "deepseek-r1-distill-70b": 141_000_000_000,
      "nemotron-3-nano-4b": 5_280_000_000,
      "deepseek-v4-flash": 352_381_000_000,
      "nemotron-3-ultra-550b-a55b": 352_381_245_521,
      "qwen3.6-35b-a3b-nvfp4": 23_500_000_000,
      "muse-glimmer-30b": 25_447_097_878,
      "nemotron-3.5-lightning-30b": 21_561_882_284,
    });
  });

  it("returns null when NEMOCLAW_VLLM_MODEL is unset so the caller can fall back to the profile default", () => {
    expect(selectVllmModelFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("exposes a global DEFAULT_VLLM_MODEL for callers that need a baseline", () => {
    // Platform-specific defaults are chosen by profiles; this constant only
    // documents the registry's first entry.
    expect(DEFAULT_VLLM_MODEL.envValue).toBe("qwen3.6-27b");
  });

  it("resolves a model by its env slug (case-insensitive)", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(deepseek).toBeDefined();
    expect(
      selectVllmModelFromEnv({
        NEMOCLAW_VLLM_MODEL: "DeepSeek-R1-Distill-70B",
      } as NodeJS.ProcessEnv),
    ).toEqual(deepseek);
  });

  it("resolves a model by its full Hugging Face id", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(
      selectVllmModelFromEnv({
        NEMOCLAW_VLLM_MODEL: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
      } as NodeJS.ProcessEnv),
    ).toEqual(deepseek);
  });

  it("registers DeepSeek V4 Flash as a managed-vLLM override", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-v4-flash");
    expect(deepseek).toBeDefined();
    expect(deepseek!.id).toBe("deepseek-ai/DeepSeek-V4-Flash");
    expect(deepseek!.maxModelLen).toBe(1048576);
    expect(
      selectVllmModelFromEnv({
        NEMOCLAW_VLLM_MODEL: "deepseek-ai/DeepSeek-V4-Flash",
      } as NodeJS.ProcessEnv),
    ).toEqual(deepseek);
  });

  it("preserves Python indentation in the DeepSeek V4 tokenizer patch", () => {
    const model = loadManagedInferenceCatalog().models.find(
      ({ metadata }) => metadata.id === "vllm.deepseek-v4-flash-0731.v1",
    );
    const preparation = model?.spec.preparation as Extract<
      ServingModelPreparation,
      { readonly ref: "snapshot-copy-and-exact-text-replacement/v1" }
    >;

    expect(preparation.exactTextReplacement.expectedText).toBe(
      '            elif reasoning_effort in ("max", "xhigh"):\n' +
        '                reasoning_effort = "max"\n' +
        "            else:\n" +
        '                reasoning_effort = "high"',
    );
    expect(preparation.exactTextReplacement.replacementText).toBe(
      '            elif reasoning_effort in ("max", "xhigh"):\n' +
        '                reasoning_effort = "max"\n' +
        '            elif reasoning_effort == "high":\n' +
        '                reasoning_effort = "high"\n' +
        "            else:\n" +
        '                reasoning_effort = "low"',
    );
  });

  it("pins the DGX Station Nemotron Ultra serving recipe", () => {
    const ultra = VLLM_MODELS.find((m) => m.envValue === "nemotron-3-ultra-550b-a55b");
    expect(ultra).toBeDefined();
    expect(ultra!.id).toBe("nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4");
    expect(ultra!.revision).toBe("183968f87ae4cedce3039313cac1fd43d112c578");
    expect(ultra!.servedModelId).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(ultra!.runtime).toMatchObject({
      image:
        "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
      imageDownloadSizeBytes: 10_670_087_425,
      modelDownloadSizeBytes: 352_381_245_521,
      loadTimeoutSec: 3600,
      dockerRunArgs: expect.arrayContaining([
        "--gpus",
        "all",
        "--shm-size",
        "17179869184b",
        "--ulimit",
        "memlock=-1",
      ]),
      dockerRunArgsMode: "replace",
      minComputeCapability: 100,
      pullTimeoutSec: 43_200,
    });
    expect(ultra!.runtime?.minGpuMemoryBytes).toBeUndefined();

    const cmd = buildVllmServeCommand(ultra!);
    expect(cmd).toContain("export VLLM_WEIGHT_OFFLOADING_DISABLE_PIN_MEMORY=1");
    expect(cmd).toContain("export VLLM_NVFP4_GEMM_BACKEND=flashinfer-trtllm");
    expect(cmd).toContain("vllm serve nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4");
    expect(cmd).toContain("--max-model-len 262144");
    expect(cmd).toContain("--revision 183968f87ae4cedce3039313cac1fd43d112c578");
    expect(cmd).toContain("--cpu-offload-gb 150");
    expect(cmd).toContain(`--kernel-config '{"enable_flashinfer_autotune":false}'`);
    expect(cmd).toContain("--reasoning-parser nemotron_v3");
    expect(cmd).not.toContain("--trust-remote-code");
  });

  it("builds the pinned two-Station Nemotron Ultra vLLM v0.25.1 Ray head command", () => {
    const cmd = buildNemotronUltraDistributedServeCommand({
      nodeRank: 0,
      masterAddr: "192.168.240.1",
      masterPort: 6379,
      apiPort: 19000,
    });

    expect(cmd).toContain('python3 -m pip install --user --no-cache-dir "ray==2.56.0"');
    expect(cmd).toContain(
      "ray start --head --node-ip-address=192.168.240.1 --port=6379 --num-gpus=1",
    );
    expect(cmd).toContain("vllm serve nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4");
    expect(cmd).toContain("--tensor-parallel-size 1");
    expect(cmd).toContain("--pipeline-parallel-size 2");
    expect(cmd).toContain("--distributed-executor-backend ray");
    expect(cmd).toContain("--kv-cache-dtype fp8");
    expect(cmd).toContain("--max-model-len 262144");
    expect(cmd).not.toContain("--trust-remote-code");
    expect(cmd).toContain("--distributed-timeout-seconds 7200");
    expect(cmd).toContain("--served-model-name nemotron-ultra");
    expect(cmd).toContain("--host 192.168.240.1");
    expect(cmd).toContain("--port 19000");
    expect(cmd).toContain("--max-num-seqs 256");
    expect(cmd).toContain("--gpu-memory-utilization 0.9");
    expect(cmd).not.toContain("--kernel-config");
    expect(cmd).not.toContain("--kernel_config");
    expect(cmd).not.toContain("--speculative-config");
    expect(cmd).not.toContain("--cpu-offload");
  });

  it("builds a Ray worker command without starting a second API server", () => {
    const head = buildNemotronUltraDistributedServeCommand({
      nodeRank: 0,
      masterAddr: "192.168.240.1",
      masterPort: 6379,
      apiPort: 8000,
    });
    const worker = buildNemotronUltraDistributedServeCommand({
      nodeRank: 1,
      masterAddr: "192.168.240.1",
      masterPort: 6379,
      nodeAddr: "192.168.240.2",
      apiPort: 8000,
    });

    expect(worker).toContain(
      "ray start --address=192.168.240.1:6379 --node-ip-address=192.168.240.2 --num-gpus=1 --block",
    );
    expect(worker).not.toContain("vllm serve");
    expect(head).toContain("vllm serve");
  });

  it("rejects invalid two-Station Nemotron Ultra rendezvous options", () => {
    expect(() =>
      buildNemotronUltraDistributedServeCommand({
        nodeRank: 0,
        masterAddr: "station a",
        masterPort: 6379,
        apiPort: 8000,
      }),
    ).toThrow(/masterAddr/);
    expect(() =>
      buildNemotronUltraDistributedServeCommand({
        nodeRank: 1,
        masterAddr: "192.168.240.1",
        masterPort: 70000,
        apiPort: 8000,
      }),
    ).toThrow(/masterPort/);
    expect(() =>
      buildNemotronUltraDistributedServeCommand({
        nodeRank: 1,
        masterAddr: "192.168.240.1",
        masterPort: 6379,
        nodeAddr: "worker.example.com",
        apiPort: 8000,
      }),
    ).toThrow(/nodeAddr/);
    expect(() =>
      buildNemotronUltraDistributedServeCommand({
        nodeRank: 0,
        masterAddr: "192.168.240.1",
        masterPort: 6379,
        apiPort: 70_000,
      }),
    ).toThrow(/apiPort/);
    expect(() =>
      buildNemotronUltraDistributedServeCommand({
        nodeRank: 0,
        masterAddr: "192.168.240.1",
        masterPort: 6379,
        apiPort: 80,
      }),
    ).toThrow(/apiPort/);
  });

  it("rejects an unknown NEMOCLAW_VLLM_MODEL with a helpful message", () => {
    expect(() =>
      selectVllmModelFromEnv({
        NEMOCLAW_VLLM_MODEL: "made-up-model",
      } as NodeJS.ProcessEnv),
    ).toThrow(/Unknown NEMOCLAW_VLLM_MODEL='made-up-model'/);
  });

  it("treats an empty NEMOCLAW_VLLM_MODEL the same as unset", () => {
    expect(
      selectVllmModelFromEnv({
        NEMOCLAW_VLLM_MODEL: "   ",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("passes the gated check when HF_TOKEN is present", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(() =>
      assertGatedModelAccess(deepseek!, {
        HF_TOKEN: "hf_abc",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("accepts HUGGING_FACE_HUB_TOKEN as an equivalent token", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(() =>
      assertGatedModelAccess(deepseek!, {
        HUGGING_FACE_HUB_TOKEN: "hf_abc",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("rejects a gated model when no Hugging Face token is set", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(() => assertGatedModelAccess(deepseek!, {} as NodeJS.ProcessEnv)).toThrow(
      /gated on Hugging Face/,
    );
  });

  it("keeps the public Nemotron Ultra recipe usable without a Hugging Face token", () => {
    const ultra = VLLM_MODELS.find((m) => m.envValue === "nemotron-3-ultra-550b-a55b");
    expect(ultra?.gated).toBe(false);
    expect(() => assertGatedModelAccess(ultra!, {} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("never rejects a non-gated model regardless of token state", () => {
    const qwen = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-27b");
    expect(() => assertGatedModelAccess(qwen!, {} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("builds a vllm serve command that includes both shared and model-specific flags", () => {
    const qwen = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-27b");
    const cmd = buildVllmServeCommand(qwen!);
    expect(cmd).toContain("pip install vllm[fastsafetensors]");
    expect(cmd).toContain("vllm serve Qwen/Qwen3.6-27B-FP8");
    expect(cmd).toContain("--gpu-memory-utilization 0.7");
    expect(cmd).toContain("--port 8000");
    expect(cmd).toContain("--max-model-len 262144");
    expect(cmd).toContain("--reasoning-parser qwen3");
    expect(cmd).toContain("--tool-call-parser qwen3_coder");
    expect(cmd).toContain("--load-format fastsafetensors");
  });

  it("appends validated managed-vLLM extra serve args after registry defaults", () => {
    const qwen = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-27b");
    const cmd = buildVllmServeCommand(qwen!, {
      [VLLM_EXTRA_ARGS_ENV]: JSON.stringify([
        "--max-num-seqs",
        "2",
        "--speculative-config",
        '{"method":"ngram","num_speculative_tokens":1}',
        "--served-model-name",
        "operator test model",
      ]),
    } as NodeJS.ProcessEnv);

    expect(cmd).toContain("--max-num-seqs 2");
    expect(cmd).toContain(`--speculative-config '{"method":"ngram","num_speculative_tokens":1}'`);
    expect(cmd).toContain("--served-model-name 'operator test model'");
    expect(cmd.indexOf("--load-format fastsafetensors")).toBeLessThan(
      cmd.indexOf("--served-model-name 'operator test model'"),
    );
  });

  it("quotes single quotes in managed-vLLM extra serve args", () => {
    const qwen = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-27b");
    const cmd = buildVllmServeCommand(qwen!, {
      [VLLM_EXTRA_ARGS_ENV]: JSON.stringify(["--served-model-name", "operator's model"]),
    } as NodeJS.ProcessEnv);

    expect(cmd).toContain(`--served-model-name 'operator'"'"'s model'`);
  });

  it("quotes registry arguments and serving environment values as shell literals (#8246)", () => {
    const qwen = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-27b");
    const cmd = buildVllmServeCommand({
      ...qwen!,
      id: "example/model; touch /tmp/model-injection",
      modelArgs: ["--served-model-name", "$(touch /tmp/argument-injection)"],
      serveEnv: { SAFE_VALUE: "literal; $(touch /tmp/environment-injection)" },
    });

    expect(cmd).toContain("export SAFE_VALUE='literal; $(touch /tmp/environment-injection)'");
    expect(cmd).toContain("vllm serve 'example/model; touch /tmp/model-injection'");
    expect(cmd).toContain("--served-model-name '$(touch /tmp/argument-injection)'");
  });

  it("rejects invalid serving environment variable names", () => {
    const qwen = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-27b");

    expect(() =>
      buildVllmServeCommand({
        ...qwen!,
        serveEnv: { "UNSAFE; touch /tmp/environment-name-injection": "1" },
      }),
    ).toThrow("Invalid vLLM serving environment variable name");
  });

  it("uses model-specific max-model-len when building the command", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    const cmd = buildVllmServeCommand(deepseek!);
    expect(cmd).toContain("vllm serve deepseek-ai/DeepSeek-R1-Distill-Llama-70B");
    expect(cmd).toContain("--max-model-len 32768");
    expect(cmd).toContain("--reasoning-parser deepseek_r1");
    expect(cmd).toContain("--tool-call-parser hermes");
    expect(cmd).not.toContain("--reasoning-parser qwen3");
  });

  it("builds the DeepSeek V4 Flash serve command with inherited one-GPU defaults", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-v4-flash");
    const cmd = buildVllmServeCommand(deepseek!);
    expect(cmd).toContain("vllm serve deepseek-ai/DeepSeek-V4-Flash");
    expect(cmd).toContain("--tensor-parallel-size 1");
    expect(cmd).toContain("--pipeline-parallel-size 1");
    expect(cmd).toContain("--data-parallel-size 1");
    expect(cmd).toContain("--port 8000");
    expect(cmd).toContain("--kv-cache-dtype fp8");
    expect(cmd).not.toContain("--trust-remote-code");
    expect(cmd).toContain("--block-size 256");
    expect(cmd).toContain("--enable-prefix-caching");
    expect(cmd).toContain("--gpu-memory-utilization 0.92");
    expect(cmd).toContain(
      `--compilation-config '{"cudagraph_mode":"FULL_AND_PIECEWISE","custom_ops":["all"]}'`,
    );
    expect(cmd).toContain("--attention_config.use_fp4_indexer_cache True");
    expect(cmd).toContain("--tokenizer-mode deepseek_v4");
    expect(cmd).toContain("--tool-call-parser deepseek_v4");
    expect(cmd).toContain("--enable-auto-tool-choice");
    expect(cmd).toContain("--reasoning-parser deepseek_v4");
    expect(cmd).toContain("--no-disable-hybrid-kv-cache-manager");
    expect(cmd).toContain("--disable-uvicorn-access-log");
    expect(cmd).toContain("--max-cudagraph-capture-size 128");
    expect(cmd).toContain(`--speculative-config '{"method":"mtp","num_speculative_tokens":3}'`);
    expect(cmd).toContain("--max-model-len 1048576");
    expect(cmd).toContain("--max-num-batched-tokens 8192");
    expect(cmd).toContain("--max-num-seqs 16");
    expect(cmd).toContain("--prefix-cache-retention-interval auto");
    expect(cmd).toContain("pip install vllm[fastsafetensors]");
    expect(cmd).not.toContain("--gpu-memory-utilization 0.7");
  });

  it("builds the Nemotron-3-Nano-4B FP8 serve command with auto tool-choice and reasoning parser (#6314, #6915)", () => {
    // #6314: the generic-Linux managed-vLLM default (`GENERIC_LINUX_PROFILE.defaultModel`)
    // used to omit `--enable-auto-tool-choice` and `--tool-call-parser`, so every agent
    // request with `tool_choice: "auto"` failed HTTP 400 out of the box on generic Linux.
    // The Spark and Station defaults already pinned their own tool-call parser; this
    // asserts the same is true for the Nemotron-3-Nano-4B checkpoint that generic Linux
    // resolves to, matching the vLLM launch example on the model card.
    const nemotronNano = VLLM_MODELS.find((m) => m.envValue === "nemotron-3-nano-4b");
    expect(nemotronNano).toBeDefined();
    const cmd = buildVllmServeCommand(nemotronNano!);
    expect(cmd).toContain("vllm serve nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8");
    expect(cmd).toContain("--max-model-len 262144");
    expect(cmd).toContain("--gpu-memory-utilization 0.7");
    expect(cmd).toContain("--load-format fastsafetensors");
    expect(cmd).toContain("--enable-auto-tool-choice");
    expect(cmd).toContain("--tool-call-parser qwen3_coder");
    // #6915: Nemotron-3-Nano is a reasoning model, so the serve command must
    // also pin the reasoning parser from the model card. Without it, vLLM
    // leaves the `<think>…</think>` trace (and the orphan `</think>` marker the
    // chat template does not pair with an opening tag) inline in `content`,
    // which the agent's streaming parser mishandles into an empty turn that
    // wedges the session. The Ultra-550B managed profile already pins the same
    // `nemotron_v3` parser; this asserts the generic-Linux Nano default matches.
    expect(cmd).toContain("--reasoning-parser nemotron_v3");
    // The parser flags must appear paired and exactly once each: the value is a
    // single shell token immediately after its switch.
    expect(cmd.match(/--enable-auto-tool-choice/g)).toHaveLength(1);
    expect(cmd.match(/--tool-call-parser/g)).toHaveLength(1);
    expect(cmd.match(/--reasoning-parser/g)).toHaveLength(1);
  });

  it("registers the Qwen3.6-35B NVFP4 checkpoint for DGX Spark", () => {
    const qwen35b = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-35b-a3b-nvfp4");
    expect(qwen35b).toBeDefined();
    expect(qwen35b!.id).toBe("nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(qwen35b!.gated).toBe(false);
  });

  it("builds the MTP-free NVFP4 serve command for DGX Spark (#7127)", () => {
    const qwen35b = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-35b-a3b-nvfp4");
    const cmd = buildVllmServeCommand(qwen35b!);
    // The current NVIDIA model card no longer needs Spark-specific env exports.
    expect(cmd).not.toContain("VLLM_USE_FLASHINFER_MOE_FP4");
    expect(cmd).not.toContain("VLLM_FP8_MOE_BACKEND");
    expect(cmd).not.toContain("FLASHINFER_DISABLE_VERSION_CHECK");
    expect(cmd).not.toContain("CUTE_DSL_ARCH");
    // fastsafetensors is always installed and used.
    expect(cmd).toContain("pip install vllm[fastsafetensors]");
    expect(cmd).toContain("--load-format fastsafetensors");
    // Model-specific flags appended on top of the shared serving defaults.
    expect(cmd).toContain("vllm serve nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(cmd).toContain("--quantization modelopt");
    expect(cmd).toContain("--kv-cache-dtype fp8");
    expect(cmd).toContain("--attention-backend flashinfer");
    expect(cmd).toContain("--moe-backend marlin");
    expect(cmd).toContain("--enable-auto-tool-choice");
    // #6457: `qwen3_coder` (not `qwen3_xml`) is the validated tool-call parser
    // for this Spark checkpoint; `qwen3_xml` mis-parses its tool-call frames and
    // breaks Deep Agents Code tool calls with HTTP 400.
    expect(cmd).toContain("--tool-call-parser qwen3_coder");
    expect(cmd).not.toContain("qwen3_xml");
    // Exactly one tool-call parser is configured for the Spark recipe, so the
    // #6457 regression (serving this checkpoint with qwen3_xml, which mis-parses
    // its tool-call frames and fails Deep Agents Code with HTTP 400) cannot creep
    // back in alongside qwen3_coder.
    expect(cmd.match(/--tool-call-parser/g)).toHaveLength(1);
    expect(cmd).toContain("--reasoning-parser qwen3");
    expect(cmd).toContain("--max-model-len 262144");
    expect(cmd).toContain("--dtype auto");
    expect(cmd).toContain("--max-num-seqs 4");
    expect(cmd).toContain("--max-num-batched-tokens 8192");
    expect(cmd).toContain("--enable-chunked-prefill");
    expect(cmd).toContain("--async-scheduling");
    expect(cmd).toContain("--enable-prefix-caching");
    expect(cmd).not.toContain("--speculative-config");
    expect(cmd).not.toContain('"method":"mtp"');
    // Single-node parallel flags stay shared; 0.4 utilization follows the
    // current DGX Spark model-card recipe.
    expect(cmd).toContain("--gpu-memory-utilization 0.4");
    expect(cmd).toContain("--pipeline-parallel-size 1");
    expect(cmd).toContain("--data-parallel-size 1");
    expect(cmd).not.toContain("--gpu-memory-utilization 0.7");
  });

  it("pins the authenticated Muse Glimmer model across Spark and Linux", () => {
    const muse = VLLM_MODELS.find((model) => model.envValue === "muse-glimmer-30b");

    expect(muse).toMatchObject({
      id: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
      label: "Muse Glimmer 30B NVFP4 W4A4 [Experimental]",
      revision: "d35cb79050f419c457611b1cee5c5d15b176f285",
      servedModelId: "muse-glimmer",
      maxModelLen: 32768,
      platforms: ["spark", "linux"],
      minComputeCapability: 120,
      gated: false,
      installFastSafetensors: false,
      trustRemoteCode: false,
      managedBearerAuth: true,
      requireRuntimeVariant: true,
    });

    const command = buildVllmServeCommand(muse!);
    expect(command).toContain("vllm serve Inferact/Muse-Glimmer-30B-NVFP4-W4A4");
    expect(command).toContain("--served-model-name muse-glimmer");
    expect(command).toContain("--revision d35cb79050f419c457611b1cee5c5d15b176f285");
    expect(command).toContain("--max-model-len 32768");
    expect(command).toContain("--gpu-memory-utilization 0.75");
    expect(command).toContain("--max-num-seqs 1");
    expect(command).toContain("--max-num-batched-tokens 4096");
    expect(command).toContain("--enable-auto-tool-choice");
    expect(command).toContain("--tool-call-parser muse_glimmer");
    expect(command).toContain("--reasoning-parser muse_glimmer");
    expect(command).toContain("--generation-config auto");
    expect(command).not.toContain("--trust-remote-code");
    expect(command).not.toContain("--quantization");
    expect(command).not.toContain("--speculative-config");
    expect(command).not.toContain("pip install");
  });

  it("pins the published Lightning parser baseline across managed variants", () => {
    const lightning = VLLM_MODELS.find((model) => model.envValue === "nemotron-3.5-lightning-30b");

    expect(lightning).toMatchObject({
      id: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
      platforms: ["spark", "linux"],
      pickerPlatforms: [],
      minComputeCapability: 90,
      requireRuntimeVariant: true,
    });
    const sparkProfile = detectVllmProfile({ platform: "spark", type: "nvidia" })!;
    const sparkModel = resolveVllmModelRuntime(sparkProfile, lightning!, "arm64").model;
    const command = buildVllmServeCommand(sparkModel);
    expect(command).toContain("--mamba-backend flashinfer");
    expect(command).toContain("--tool-call-parser step3p5");
    expect(command).toContain("--reasoning-parser step3p5");
    expect(command).toContain("--moe-backend marlin");
    expect(command).toContain("--speculative-config");
  });
});

describe("modelsForPlatform", () => {
  it("offers only the accepted Qwen3.6 profile on N1x (#8574)", () => {
    expect(modelsForPlatform("n1x").map((model) => model.envValue)).toEqual([
      "qwen3.6-35b-a3b-nvfp4",
    ]);
  });

  it("returns the Spark-runnable subset for DGX Spark", () => {
    const slugs = modelsForPlatform("spark").map((m) => m.envValue);
    expect(slugs).toContain("qwen3.6-35b-a3b-nvfp4");
    expect(slugs).toContain("qwen3.6-27b");
    expect(slugs).toContain("nemotron-3-nano-4b");
    expect(slugs).toContain("deepseek-r1-distill-70b");
    expect(slugs).toContain("muse-glimmer-30b");
    expect(slugs).not.toContain("nemotron-3.5-lightning-30b");
    expect(slugs).not.toContain("deepseek-v4-flash");
  });

  it("returns the Station-runnable subset for DGX Station", () => {
    const slugs = modelsForPlatform("station").map((m) => m.envValue);
    expect(slugs).toContain("qwen3.6-27b");
    expect(slugs).toContain("nemotron-3-nano-4b");
    expect(slugs).toContain("deepseek-r1-distill-70b");
    expect(slugs).toContain("deepseek-v4-flash");
    expect(slugs).toContain("nemotron-3-ultra-550b-a55b");
    expect(slugs).not.toContain("qwen3.6-35b-a3b-nvfp4");
    expect(slugs).not.toContain("muse-glimmer-30b");
    expect(slugs).not.toContain("nemotron-3.5-lightning-30b");
  });

  it("keeps newly added Linux compatibility paths out of the interactive picker", () => {
    const slugs = modelsForPlatform("linux").map((m) => m.envValue);
    expect(slugs).toContain("qwen3.6-27b");
    expect(slugs).toContain("nemotron-3-nano-4b");
    expect(slugs).toContain("deepseek-r1-distill-70b");
    expect(slugs).not.toContain("qwen3.6-35b-a3b-nvfp4");
    expect(slugs).not.toContain("muse-glimmer-30b");
    expect(slugs).not.toContain("nemotron-3.5-lightning-30b");
    expect(slugs).not.toContain("deepseek-v4-flash");
  });

  it("preserves registry order so callers can stably mark the recommended entry", () => {
    const registryOrder = VLLM_MODELS.filter((m) =>
      (m.pickerPlatforms ?? m.platforms).includes("spark"),
    ).map((m) => m.envValue);
    expect(modelsForPlatform("spark").map((m) => m.envValue)).toEqual(registryOrder);
  });
});

describe("parseVllmExtraServeArgs", () => {
  it("returns no extra args when the env var is unset or blank", () => {
    expect(parseVllmExtraServeArgs({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(
      parseVllmExtraServeArgs({
        [VLLM_EXTRA_ARGS_ENV]: "  ",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("parses a JSON array of extra vLLM serve argument tokens", () => {
    expect(
      parseVllmExtraServeArgs({
        [VLLM_EXTRA_ARGS_ENV]: '[" --max-num-seqs ","2"]',
      } as NodeJS.ProcessEnv),
    ).toEqual(["--max-num-seqs", "2"]);
  });

  it("rejects malformed managed-vLLM extra args before docker work starts", () => {
    expect(() =>
      parseVllmExtraServeArgs({
        [VLLM_EXTRA_ARGS_ENV]: '{"not":"an array"}',
      } as NodeJS.ProcessEnv),
    ).toThrow(/JSON array/);

    expect(() =>
      parseVllmExtraServeArgs({
        [VLLM_EXTRA_ARGS_ENV]: '["--max-num-seqs",2]',
      } as NodeJS.ProcessEnv),
    ).toThrow(/\[1\] must be a string/);

    expect(() =>
      parseVllmExtraServeArgs({
        [VLLM_EXTRA_ARGS_ENV]: '["   "]',
      } as NodeJS.ProcessEnv),
    ).toThrow(/\[0\] must not be empty/);

    expect(() =>
      parseVllmExtraServeArgs({
        [VLLM_EXTRA_ARGS_ENV]: '["line\\nbreak"]',
      } as NodeJS.ProcessEnv),
    ).toThrow(/control characters/);
  });
});

describe("resolveVllmGpuMemoryUtilization", () => {
  it("uses the last appended override in either supported argv form", () => {
    expect(
      resolveVllmGpuMemoryUtilization(0.7, [
        "--gpu-memory-utilization=0.8",
        "--gpu-memory-utilization",
        "0.5",
      ]),
    ).toBe(0.5);
    expect(resolveVllmGpuMemoryUtilization(0.7, ["--gpu_memory_utilization=0.6"])).toBe(0.6);
    expect(resolveVllmGpuMemoryUtilization(undefined, ["--max-num-seqs", "2"])).toBeUndefined();
  });

  it.each([
    [".5", 0.5],
    ["1.", 1],
    ["+0.5", 0.5],
    ["5e-1", 0.5],
  ])("accepts the vLLM float value %s", (value, expected) => {
    expect(resolveVllmGpuMemoryUtilization(0.7, ["--gpu-memory-utilization", value])).toBe(
      expected,
    );
  });

  it.each(["--gpu-memory-u", "--gpu_memory_u=0.5"])(
    "rejects the abbreviated option %s",
    (option) => {
      expect(() => resolveVllmGpuMemoryUtilization(0.7, [option, "0.5"])).toThrow(
        /must use the full --gpu-memory-utilization option name/,
      );
    },
  );

  it("rejects a missing utilization value", () => {
    expect(() => resolveVllmGpuMemoryUtilization(0.7, ["--gpu-memory-utilization"])).toThrow(
      /requires a value/,
    );
  });

  it.each(["", ".", "+", "0", "1.1", "1e1", "5e", "0x1", "NaN", "--max-num-seqs"])(
    "rejects invalid utilization value %j",
    (value) => {
      expect(() =>
        resolveVllmGpuMemoryUtilization(0.7, ["--gpu-memory-utilization", value]),
      ).toThrow(/decimal number greater than 0 and at most 1/);
    },
  );
});

describe("preflightVllmModelEnv", () => {
  it("succeeds when NEMOCLAW_VLLM_MODEL is unset", () => {
    expect(preflightVllmModelEnv({} as NodeJS.ProcessEnv)).toEqual({
      ok: true,
    });
  });

  it("succeeds for a recognised non-gated slug", () => {
    expect(
      preflightVllmModelEnv({
        NEMOCLAW_VLLM_MODEL: "qwen3.6-27b",
      } as NodeJS.ProcessEnv),
    ).toEqual({ ok: true });
  });

  it("succeeds for a gated slug when HF_TOKEN is set", () => {
    expect(
      preflightVllmModelEnv({
        NEMOCLAW_VLLM_MODEL: "deepseek-r1-distill-70b",
        HF_TOKEN: "hf_abc",
      } as NodeJS.ProcessEnv),
    ).toEqual({ ok: true });
  });

  it("succeeds for a gated slug when HUGGING_FACE_HUB_TOKEN is set", () => {
    expect(
      preflightVllmModelEnv({
        NEMOCLAW_VLLM_MODEL: "deepseek-r1-distill-70b",
        HUGGING_FACE_HUB_TOKEN: "hf_abc",
      } as NodeJS.ProcessEnv),
    ).toEqual({ ok: true });
  });

  it("fails fast for a gated slug with no Hugging Face token", () => {
    const result = preflightVllmModelEnv({
      NEMOCLAW_VLLM_MODEL: "deepseek-r1-distill-70b",
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/gated on Hugging Face/);
      expect(result.message).toMatch(/HF_TOKEN/);
      expect(result.message).toMatch(/HUGGING_FACE_HUB_TOKEN/);
    }
  });

  it("fails fast for an unknown slug", () => {
    const result = preflightVllmModelEnv({
      NEMOCLAW_VLLM_MODEL: "made-up-model",
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/Unknown NEMOCLAW_VLLM_MODEL='made-up-model'/);
    }
  });

  it("fails fast for malformed managed-vLLM extra args", () => {
    const result = preflightVllmModelEnv({
      [VLLM_EXTRA_ARGS_ENV]: '["--max-num-seqs",2]',
    } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/NEMOCLAW_VLLM_EXTRA_ARGS_JSON/);
      expect(result.message).toMatch(/\[1\] must be a string/);
    }
  });
});
