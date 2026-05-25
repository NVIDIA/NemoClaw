// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry of models the express vLLM install path knows how to serve.
 *
 * Each entry pins the model-specific `vllm serve` flags (reasoning parser,
 * tool-call parser, max model length, load format) so the express path can
 * swap models without leaving the wrong flags behind. Users select a model
 * via `NEMOCLAW_VLLM_MODEL=<envValue>` before invoking the installer; the
 * default (when the env var is unset) is the first entry.
 *
 * Gated entries (e.g. DeepSeek-R1 Distill Llama 70B) require the operator
 * to have accepted the model's licence on Hugging Face AND export a
 * compatible `HF_TOKEN`; `assertGatedModelAccess` enforces the token check
 * before the wizard pulls the model weights so the failure is fast and the
 * user knows exactly which token to provision.
 *
 * The registry is deliberately small and additive — extend it when QA
 * adds a model to the express coverage matrix (related: NemoClaw issue
 * tracking the express vLLM model picker).
 */

export interface VllmModelDef {
  /** Hugging Face model id (also passed to `vllm serve`). */
  id: string;
  /** Human-readable label shown in wizard summaries. */
  label: string;
  /** Stable identifier accepted via `NEMOCLAW_VLLM_MODEL`. */
  envValue: string;
  /** `--max-model-len` flag value. */
  maxModelLen: number;
  /** Model-specific flags appended after the shared serving flags. */
  modelArgs: string[];
  /** True when the upstream HF repo requires accepting a licence. */
  gated: boolean;
}

export const VLLM_MODELS: readonly VllmModelDef[] = [
  {
    id: "Qwen/Qwen3.6-27B-FP8",
    label: "Qwen3.6 27B FP8",
    envValue: "qwen3.6-27b",
    maxModelLen: 262144,
    modelArgs: [
      "--max-num-seqs",
      "4",
      "--reasoning-parser",
      "qwen3",
      "--enable-auto-tool-choice",
      "--tool-call-parser",
      "qwen3_coder",
      "--load-format",
      "fastsafetensors",
      "--enable-prefix-caching",
    ],
    gated: false,
  },
  {
    id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
    label: "DeepSeek-R1 Distill Llama 70B",
    envValue: "deepseek-r1-distill-70b",
    maxModelLen: 32768,
    modelArgs: [
      "--max-num-seqs",
      "4",
      "--reasoning-parser",
      "deepseek_r1",
      "--enable-auto-tool-choice",
      "--tool-call-parser",
      "hermes",
    ],
    gated: true,
  },
  {
    id: "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8",
    label: "NVIDIA Nemotron-3 Nano 4B FP8",
    envValue: "nemotron-3-nano-4b",
    // Matches the model card's `max_position_embeddings` and the vLLM
    // example NVIDIA publishes for this checkpoint. The previous value
    // (262000) was an undocumented round-down with no headroom rationale.
    maxModelLen: 262144,
    modelArgs: ["--load-format", "fastsafetensors"],
    gated: false,
  },
] as const;

export const DEFAULT_VLLM_MODEL: VllmModelDef = VLLM_MODELS[0];

const HF_TOKEN_ENV_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;

/**
 * Look up the requested express-vLLM model from `NEMOCLAW_VLLM_MODEL`.
 * Returns `null` when the env var is empty so the caller can fall back to
 * the per-platform profile default (Spark/Station prefer Qwen3.6-27B, the
 * generic Linux profile prefers Nemotron-Nano-4B for VRAM headroom).
 *
 * Match is case-insensitive against either the `envValue` slug or the full
 * HF id. Throws when the env var names something not in the registry so the
 * user gets a single clear message instead of a downstream vLLM startup
 * failure.
 */
export function selectVllmModelFromEnv(env: NodeJS.ProcessEnv = process.env): VllmModelDef | null {
  const requested = String(env.NEMOCLAW_VLLM_MODEL ?? "").trim().toLowerCase();
  if (!requested) return null;
  const match = VLLM_MODELS.find(
    (model) => model.envValue.toLowerCase() === requested || model.id.toLowerCase() === requested,
  );
  if (match) return match;
  const choices = VLLM_MODELS.map((model) => `'${model.envValue}'`).join(", ");
  throw new Error(
    `Unknown NEMOCLAW_VLLM_MODEL='${env.NEMOCLAW_VLLM_MODEL}'. ` +
      `Recognised values: ${choices} (or the full Hugging Face model id).`,
  );
}

/**
 * Fail fast when a gated model is requested without a Hugging Face token.
 * The check runs before `vllm serve` starts pulling weights so we don't
 * burn 10+ minutes of bandwidth on a 401 the user will hit later.
 */
export function assertGatedModelAccess(
  model: VllmModelDef,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!model.gated) return;
  const hasToken = HF_TOKEN_ENV_KEYS.some((key) => String(env[key] ?? "").trim().length > 0);
  if (hasToken) return;
  throw new Error(
    `Model '${model.id}' is gated on Hugging Face. ` +
      `Accept the model's licence on its HF page, then export a token in one of: ` +
      `${HF_TOKEN_ENV_KEYS.join(", ")}.`,
  );
}

const SHARED_VLLM_ARGS: readonly string[] = [
  "--gpu-memory-utilization",
  "0.7",
  "--tensor-parallel-size",
  "1",
  "--pipeline-parallel-size",
  "1",
  "--data-parallel-size",
  "1",
  "--port",
  "8000",
  "--trust-remote-code",
] as const;

/**
 * Build the `vllm serve` command line for the supplied model, with the
 * shared serving flags merged with the model-specific args from the
 * registry. The command starts with the `pip install` that pulls the
 * `fastsafetensors` extra so existing express scripts keep working.
 */
export function buildVllmServeCommand(model: VllmModelDef): string {
  const args = [
    ...SHARED_VLLM_ARGS,
    "--max-model-len",
    String(model.maxModelLen),
    ...model.modelArgs,
  ];
  return `pip install vllm[fastsafetensors] && vllm serve ${model.id} ${args.join(" ")}`;
}
