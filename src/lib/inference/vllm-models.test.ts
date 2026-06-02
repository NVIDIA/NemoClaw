// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_VLLM_MODEL,
  VLLM_MODELS,
  assertGatedModelAccess,
  buildVllmServeCommand,
  preflightVllmModelEnv,
  selectVllmModelFromEnv,
} from "../../../dist/lib/inference/vllm-models";

describe("vllm model registry", () => {
  it("returns null when NEMOCLAW_VLLM_MODEL is unset so the caller can fall back to the profile default", () => {
    expect(selectVllmModelFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("exposes a global DEFAULT_VLLM_MODEL for callers that need a baseline", () => {
    // The platform-specific default is chosen by the profile (Spark/Station
    // use Qwen, generic Linux uses Nemotron-Nano-4B); this constant only
    // documents the registry's first entry.
    expect(DEFAULT_VLLM_MODEL.envValue).toBe("qwen3.6-27b");
  });

  it("resolves a model by its env slug (case-insensitive)", () => {
    const deepseek = VLLM_MODELS.find((m) => m.envValue === "deepseek-r1-distill-70b");
    expect(deepseek).toBeDefined();
    expect(
      selectVllmModelFromEnv({ NEMOCLAW_VLLM_MODEL: "DeepSeek-R1-Distill-70B" } as NodeJS.ProcessEnv),
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
    expect(cmd).toContain("--max-model-len 65536");
    expect(cmd).toContain(
      `--speculative-config '{"method":"mtp","num_speculative_tokens":3,"moe_backend":"triton"}'`,
    );
    // Shared defaults are kept: 0.7 utilization and the single-node parallel
    // flags (harmless on Spark), not a model-specific 0.85 override.
    expect(cmd).toContain("--gpu-memory-utilization 0.7");
    expect(cmd).toContain("--pipeline-parallel-size 1");
    expect(cmd).toContain("--data-parallel-size 1");
    expect(cmd).not.toContain("--gpu-memory-utilization 0.85");
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
