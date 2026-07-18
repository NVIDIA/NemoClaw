// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertGatedModelAccess,
  buildVllmServeCommand,
  DEFAULT_VLLM_MODEL,
  modelsForPlatform,
  parseVllmExtraServeArgs,
  preflightVllmModelEnv,
  selectVllmModelFromEnv,
  VLLM_EXTRA_ARGS_ENV,
  VLLM_MODELS,
} from "./vllm-models";

describe("vllm model registry", () => {
  it("records a finite positive Hugging Face file size for every model", () => {
    for (const model of VLLM_MODELS) {
      expect(Number.isFinite(model.downloadSizeBytes)).toBe(true);
      expect(model.downloadSizeBytes).toBeGreaterThan(0);
    }
  });

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

  it("pins the DGX Station Nemotron Ultra serving recipe", () => {
    const ultra = VLLM_MODELS.find((m) => m.envValue === "nemotron-3-ultra-550b-a55b");
    expect(ultra).toBeDefined();
    expect(ultra!.id).toBe("nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4");
    expect(ultra!.revision).toBe("183968f87ae4cedce3039313cac1fd43d112c578");
    expect(ultra!.servedModelId).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(ultra!.runtime).toEqual({
      image:
        "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
      imageDownloadSizeBytes: 10_670_087_425,
      modelDownloadSizeBytes: 352_381_245_521,
      loadTimeoutSec: 3600,
      dockerRunArgs: ["--shm-size", "16g", "--ulimit", "memlock=-1", "--ulimit", "stack=67108864"],
    });

    const cmd = buildVllmServeCommand(ultra!);
    expect(cmd).toBe(
      [
        "export VLLM_WEIGHT_OFFLOADING_DISABLE_PIN_MEMORY=1",
        "&& export VLLM_NVFP4_GEMM_BACKEND=flashinfer-trtllm",
        "&& vllm serve nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
        "--tensor-parallel-size 1",
        "--pipeline-parallel-size 1",
        "--data-parallel-size 1",
        "--port 8000",
        "--trust-remote-code",
        "--max-model-len 262144",
        "--revision 183968f87ae4cedce3039313cac1fd43d112c578",
        "--served-model-name nvidia/nemotron-3-ultra-550b-a55b",
        "--host 0.0.0.0",
        "--cpu-offload-gb 150",
        "--cpu-offload-params experts",
        `--kernel_config '{"enable_flashinfer_autotune": false}'`,
        `--speculative-config '{"method":"nemotron_h_mtp","num_speculative_tokens":3}'`,
        "--max-num-seqs 256",
        "--gpu-memory-utilization 0.9",
        "--reasoning-parser nemotron_v3",
        "--enable-auto-tool-choice",
        "--tool-call-parser qwen3_coder",
        `--default-chat-template-kwargs '{"enable_thinking":true,"force_nonempty_content":true}'`,
      ].join(" "),
    );
  });

  it("rejects an unknown NEMOCLAW_VLLM_MODEL with a helpful message", () => {
    expect(() =>
      selectVllmModelFromEnv({ NEMOCLAW_VLLM_MODEL: "made-up-model" } as NodeJS.ProcessEnv),
    ).toThrow(/Unknown NEMOCLAW_VLLM_MODEL='made-up-model'/);
  });

  it("treats an empty NEMOCLAW_VLLM_MODEL the same as unset", () => {
    expect(selectVllmModelFromEnv({ NEMOCLAW_VLLM_MODEL: "   " } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("passes the gated check when HF_TOKEN is present", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(() =>
      assertGatedModelAccess(deepseek!, { HF_TOKEN: "hf_abc" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("accepts HUGGING_FACE_HUB_TOKEN as an equivalent token", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(() =>
      assertGatedModelAccess(deepseek!, { HUGGING_FACE_HUB_TOKEN: "hf_abc" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("rejects a gated model when no Hugging Face token is set", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(() => assertGatedModelAccess(deepseek!, {} as NodeJS.ProcessEnv)).toThrow(
      /gated on Hugging Face/,
    );
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
    expect(cmd).toContain("--trust-remote-code");
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

  it("builds the NVFP4 serve command from the DGX Spark model-card recipe (#6457)", () => {
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
    expect(cmd).toContain(
      `--speculative-config '{"method":"mtp","num_speculative_tokens":3,"moe_backend":"triton"}'`,
    );
    // Single-node parallel flags stay shared; 0.4 utilization follows the
    // current DGX Spark model-card recipe.
    expect(cmd).toContain("--gpu-memory-utilization 0.4");
    expect(cmd).toContain("--pipeline-parallel-size 1");
    expect(cmd).toContain("--data-parallel-size 1");
    expect(cmd).not.toContain("--gpu-memory-utilization 0.7");
  });
});

describe("modelsForPlatform", () => {
  it("returns the Spark-runnable subset for DGX Spark", () => {
    const slugs = modelsForPlatform("spark").map((m) => m.envValue);
    expect(slugs).toContain("qwen3.6-35b-a3b-nvfp4");
    expect(slugs).toContain("qwen3.6-27b");
    expect(slugs).toContain("nemotron-3-nano-4b");
    expect(slugs).toContain("deepseek-r1-distill-70b");
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
  });

  it("omits arch-specific entries from the generic Linux profile", () => {
    const slugs = modelsForPlatform("linux").map((m) => m.envValue);
    expect(slugs).toContain("qwen3.6-27b");
    expect(slugs).toContain("nemotron-3-nano-4b");
    expect(slugs).toContain("deepseek-r1-distill-70b");
    expect(slugs).not.toContain("qwen3.6-35b-a3b-nvfp4");
    expect(slugs).not.toContain("deepseek-v4-flash");
  });

  it("preserves registry order so callers can stably mark the recommended entry", () => {
    const registryOrder = VLLM_MODELS.filter((m) => m.platforms.includes("spark")).map(
      (m) => m.envValue,
    );
    expect(modelsForPlatform("spark").map((m) => m.envValue)).toEqual(registryOrder);
  });
});

describe("parseVllmExtraServeArgs", () => {
  it("returns no extra args when the env var is unset or blank", () => {
    expect(parseVllmExtraServeArgs({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(parseVllmExtraServeArgs({ [VLLM_EXTRA_ARGS_ENV]: "  " } as NodeJS.ProcessEnv)).toEqual(
      [],
    );
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

describe("preflightVllmModelEnv", () => {
  it("succeeds when NEMOCLAW_VLLM_MODEL is unset", () => {
    expect(preflightVllmModelEnv({} as NodeJS.ProcessEnv)).toEqual({ ok: true });
  });

  it("succeeds for a recognised non-gated slug", () => {
    expect(
      preflightVllmModelEnv({ NEMOCLAW_VLLM_MODEL: "qwen3.6-27b" } as NodeJS.ProcessEnv),
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
