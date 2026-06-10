// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_VLLM_MODEL,
  VLLM_MODELS,
  assertGatedModelAccess,
  buildVllmServeCommand,
  modelsForPlatform,
  preflightVllmModelEnv,
  selectVllmModelFromEnv,
} from "../../../dist/lib/inference/vllm-models";

describe("vllm model registry", () => {
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
    expect(cmd).toContain(
      `--speculative-config '{"method":"mtp","num_speculative_tokens":3,"rejection_sample_method":"synthetic","synthetic_acceptance_length":3}'`,
    );
    expect(cmd).toContain("--max-model-len 1048576");
    expect(cmd).toContain("--max-num-batched-tokens 8192");
    expect(cmd).toContain("--max-num-seqs 16");
    expect(cmd).toContain("--prefix-cache-retention-interval auto");
    expect(cmd).toContain("pip install vllm[fastsafetensors]");
    expect(cmd).not.toContain("--gpu-memory-utilization 0.7");
  });

  it("registers the Qwen3.6-35B NVFP4 checkpoint for DGX Spark", () => {
    const qwen35b = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-35b-a3b-nvfp4");
    expect(qwen35b).toBeDefined();
    expect(qwen35b!.id).toBe("nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(qwen35b!.gated).toBe(false);
  });

  it("builds the NVFP4 serve command with env exports, the fastsafetensors install, and additive model flags", () => {
    const qwen35b = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-35b-a3b-nvfp4");
    const cmd = buildVllmServeCommand(qwen35b!);
    // Env exports are prefixed before serve.
    expect(cmd).toContain("export VLLM_USE_FLASHINFER_MOE_FP4=0");
    expect(cmd).toContain("export VLLM_FP8_MOE_BACKEND=flashinfer_cutlass");
    expect(cmd).toContain("export FLASHINFER_DISABLE_VERSION_CHECK=1");
    expect(cmd).toContain("export CUTE_DSL_ARCH=sm_121a");
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
    expect(cmd).toContain("--tool-call-parser qwen3_coder");
    expect(cmd).toContain("--reasoning-parser qwen3");
    expect(cmd).toContain("--max-model-len 131072");
    expect(cmd).toContain(
      `--speculative-config '{"method":"mtp","num_speculative_tokens":3,"moe_backend":"triton"}'`,
    );
    // Single-node parallel flags stay shared; 0.7 utilization stays
    // model-specific, not a stale 0.85 override.
    expect(cmd).toContain("--gpu-memory-utilization 0.7");
    expect(cmd).toContain("--pipeline-parallel-size 1");
    expect(cmd).toContain("--data-parallel-size 1");
    expect(cmd).not.toContain("--gpu-memory-utilization 0.85");
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
});
