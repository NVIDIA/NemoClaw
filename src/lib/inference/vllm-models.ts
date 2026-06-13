// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry of models the express vLLM install path knows how to serve.
 *
 * Each entry pins the model-specific `vllm serve` flags (reasoning parser,
 * tool-call parser, max model length, load format) so the express path can
 * swap models without leaving the wrong flags behind.
 *
 * Selection precedence in `installVllm`:
 *   1. `NEMOCLAW_VLLM_MODEL=<envValue-or-HF-id>` for automation overrides.
 *   2. Interactive picker over the per-platform subset (via
 *      `modelsForPlatform`), defaulting to the profile's `defaultModel`.
 *   3. Non-interactive runs without an override use the profile default
 *      directly, never the first registry entry.
 *
 * Gated entries (e.g. DeepSeek-R1 Distill Llama 70B) require the operator
 * to have accepted the model's licence on Hugging Face AND export a
 * compatible `HF_TOKEN`; `assertGatedModelAccess` enforces the token check
 * before the wizard pulls the model weights so the failure is fast and the
 * user knows exactly which token to provision.
 *
 * The registry is deliberately small and additive — extend it only when a
 * new checkpoint has its `vllm serve` flags, context length, memory
 * envelope, and tool-call behaviour validated.
 */

export type VllmPlatform = "spark" | "station" | "linux";

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
  /**
   * Platforms whose interactive picker should offer this entry. Models with
   * platform-specific flags (the NVFP4 MoE checkpoint targets `sm_121a` only,
   * the very large V4 Flash recipe wants Station-class VRAM) appear only on
   * profiles they can actually run on. Non-interactive callers and direct
   * `NEMOCLAW_VLLM_MODEL` overrides bypass the filter.
   */
  platforms: readonly VllmPlatform[];
  /**
   * Environment variables exported immediately before `vllm serve` (e.g.
   * FlashInfer / MoE-backend selection, target SM arch). Joined as
   * `export K=V && …` so they apply to the serve process inside the
   * container shell.
   */
  serveEnv?: Record<string, string>;
}

export const VLLM_MODELS: readonly VllmModelDef[] = [
  {
    id: "Qwen/Qwen3.6-27B-FP8",
    label: "Qwen3.6 27B FP8",
    envValue: "qwen3.6-27b",
    maxModelLen: 262144,
    modelArgs: [
      "--gpu-memory-utilization",
      "0.7",
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
    platforms: ["spark", "station", "linux"],
  },
  {
    id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
    label: "DeepSeek-R1 Distill Llama 70B",
    envValue: "deepseek-r1-distill-70b",
    maxModelLen: 32768,
    modelArgs: [
      "--gpu-memory-utilization",
      "0.7",
      "--max-num-seqs",
      "4",
      "--reasoning-parser",
      "deepseek_r1",
      "--enable-auto-tool-choice",
      "--tool-call-parser",
      "hermes",
    ],
    gated: true,
    platforms: ["spark", "station", "linux"],
  },
  {
    id: "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8",
    label: "NVIDIA Nemotron-3 Nano 4B FP8",
    envValue: "nemotron-3-nano-4b",
    // Matches the model card's `max_position_embeddings` and the vLLM
    // example NVIDIA publishes for this checkpoint. The previous value
    // (262000) was an undocumented round-down with no headroom rationale.
    maxModelLen: 262144,
    modelArgs: ["--gpu-memory-utilization", "0.7", "--load-format", "fastsafetensors"],
    gated: false,
    platforms: ["spark", "station", "linux"],
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    label: "DeepSeek V4 Flash",
    envValue: "deepseek-v4-flash",
    maxModelLen: 1048576,
    modelArgs: [
      "--kv-cache-dtype",
      "fp8",
      "--block-size",
      "256",
      "--enable-prefix-caching",
      "--gpu-memory-utilization",
      "0.92",
      "--compilation-config",
      `'{"cudagraph_mode":"FULL_AND_PIECEWISE","custom_ops":["all"]}'`,
      "--attention_config.use_fp4_indexer_cache",
      "True",
      "--tokenizer-mode",
      "deepseek_v4",
      "--tool-call-parser",
      "deepseek_v4",
      "--enable-auto-tool-choice",
      "--reasoning-parser",
      "deepseek_v4",
      "--no-disable-hybrid-kv-cache-manager",
      "--disable-uvicorn-access-log",
      "--max-cudagraph-capture-size",
      "128",
      "--speculative-config",
      `'{"method":"mtp","num_speculative_tokens":3,"rejection_sample_method":"synthetic","synthetic_acceptance_length":3}'`,
      "--max-num-batched-tokens",
      "8192",
      "--max-num-seqs",
      "16",
      "--prefix-cache-retention-interval",
      "auto",
    ],
    gated: false,
    platforms: ["station"],
  },
  {
    id: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    label: "Qwen3.6 35B-A3B NVFP4",
    envValue: "qwen3.6-35b-a3b-nvfp4",
    maxModelLen: 131072,
    // Additive flags on top of the shared serving defaults. The shared flags
    // already cover --tensor-parallel-size/--pipeline-parallel-size/
    // --data-parallel-size (all 1 — harmless on a single Spark node),
    // --port 8000, and --trust-remote-code; --max-model-len comes from
    // maxModelLen above.
    modelArgs: [
      "--gpu-memory-utilization",
      "0.7",
      "--dtype",
      "auto",
      "--quantization",
      "modelopt",
      "--kv-cache-dtype",
      "fp8",
      "--attention-backend",
      "flashinfer",
      "--moe-backend",
      "marlin",
      "--max-num-seqs",
      "4",
      "--max-num-batched-tokens",
      "8192",
      "--enable-chunked-prefill",
      "--async-scheduling",
      "--enable-prefix-caching",
      "--enable-auto-tool-choice",
      "--tool-call-parser",
      "qwen3_coder",
      "--reasoning-parser",
      "qwen3",
      "--speculative-config",
      `'{"method":"mtp","num_speculative_tokens":3,"moe_backend":"triton"}'`,
      "--load-format",
      "fastsafetensors",
    ],
    gated: false,
    platforms: ["spark"],
    // Arch- and backend-specific knobs required for the NVFP4 MoE checkpoint
    // on DGX Spark (GB10 / sm_121a) with the FlashInfer CUTLASS FP8 path.
    serveEnv: {
      VLLM_USE_FLASHINFER_MOE_FP4: "0",
      VLLM_FP8_MOE_BACKEND: "flashinfer_cutlass",
      FLASHINFER_DISABLE_VERSION_CHECK: "1",
      CUTE_DSL_ARCH: "sm_121a",
    },
  },
] as const;

export const DEFAULT_VLLM_MODEL: VllmModelDef = VLLM_MODELS[0];

/**
 * Subset of the registry that should appear in the interactive picker for a
 * given platform. Order matches registry order so callers can stably annotate
 * the recommended entry by id rather than position.
 */
export function modelsForPlatform(platform: VllmPlatform): readonly VllmModelDef[] {
  return VLLM_MODELS.filter((model) => model.platforms.includes(platform));
}

const HF_TOKEN_ENV_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;
export const VLLM_EXTRA_ARGS_ENV = "NEMOCLAW_VLLM_EXTRA_ARGS_JSON";

/**
 * Look up the requested express-vLLM model from `NEMOCLAW_VLLM_MODEL`.
 * Returns `null` when the env var is empty so the caller can fall back to
 * the per-platform profile default (Station prefers Qwen3.6-27B, Spark the
 * Qwen3.6-35B-A3B NVFP4 checkpoint, and the generic Linux profile prefers
 * Nemotron-Nano-4B for VRAM headroom).
 *
 * Match is case-insensitive against either the `envValue` slug or the full
 * HF id. Throws when the env var names something not in the registry so the
 * user gets a single clear message instead of a downstream vLLM startup
 * failure.
 */
export function selectVllmModelFromEnv(env: NodeJS.ProcessEnv = process.env): VllmModelDef | null {
  const requested = String(env.NEMOCLAW_VLLM_MODEL ?? "")
    .trim()
    .toLowerCase();
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

export type PreflightVllmModelResult = { ok: true } | { ok: false; message: string };

/**
 * Combined preflight for callers that hold a `NEMOCLAW_VLLM_MODEL` reference
 * but do not themselves invoke the vLLM installer — for example
 * `nemoclaw <name> connect`, which simply attaches to a running sandbox.
 *
 * The variable steers the express-vLLM install path, so on every other code
 * path the natural behaviour is to ignore it. Silent-ignore hides two real
 * user mistakes:
 *
 *   1. typos in the slug (`deepseek-r1-distill-70b` vs an old marketing
 *      name), surfaced later as the wrong model being served and a confused
 *      user; and
 *   2. requesting a gated model (DeepSeek-R1 Distill Llama 70B) without
 *      exporting `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN`, which downstream
 *      explodes as a 401 from Hugging Face partway through the pull.
 *
 * Running the same `selectVllmModelFromEnv` + `assertGatedModelAccess` checks
 * the installer uses gives the caller a single fail-fast surface and one
 * canonical message to print before any side effects. Returns
 * `{ ok: true }` when the variable is unset or resolves cleanly.
 */
export function preflightVllmModelEnv(
  env: NodeJS.ProcessEnv = process.env,
): PreflightVllmModelResult {
  try {
    parseVllmExtraServeArgs(env);
    const model = selectVllmModelFromEnv(env);
    if (!model) return { ok: true };
    assertGatedModelAccess(model, env);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export function parseVllmExtraServeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env[VLLM_EXTRA_ARGS_ENV] ?? "").trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${VLLM_EXTRA_ARGS_ENV} must be a JSON array of vLLM serve argument strings: ${
        (err as Error).message
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${VLLM_EXTRA_ARGS_ENV} must be a JSON array of strings.`);
  }

  return parsed.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`${VLLM_EXTRA_ARGS_ENV}[${String(index)}] must be a string.`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${VLLM_EXTRA_ARGS_ENV}[${String(index)}] must not be empty.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new Error(
        `${VLLM_EXTRA_ARGS_ENV}[${String(index)}] must not contain control characters.`,
      );
    }
    return trimmed;
  });
}

const SHARED_VLLM_ARGS: readonly string[] = [
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Build the `vllm serve` command line for the supplied model: the shared
 * serving flags merged with the model-specific args from the registry.
 *
 * The command is prefixed with the `pip install` that pulls the
 * `fastsafetensors` extra so existing express scripts keep working; a model
 * may prepend env exports via `serveEnv`.
 */
export function buildVllmServeCommand(
  model: VllmModelDef,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envPrefix = model.serveEnv
    ? `${Object.entries(model.serveEnv)
        .map(([key, value]) => `export ${key}=${value}`)
        .join(" && ")} && `
    : "";
  const args = [
    ...SHARED_VLLM_ARGS,
    "--max-model-len",
    String(model.maxModelLen),
    ...model.modelArgs,
  ];
  const extraArgs = parseVllmExtraServeArgs(env).map(shellQuote);
  return `${envPrefix}pip install vllm[fastsafetensors] && vllm serve ${model.id} ${[
    ...args,
    ...extraArgs,
  ].join(" ")}`;
}
