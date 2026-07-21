// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry of models the express vLLM install path knows how to serve.
 *
 * Each entry pins the model-specific `vllm serve` flags (reasoning parser,
 * tool-call parser, max model length, load format) and any required runtime
 * image/container overrides so the express path can swap models without
 * leaving the wrong recipe behind.
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

export interface VllmRuntimeOverride {
  /** Model-specific runtime image, pinned by digest. */
  image: string;
  /** Compressed size of the selected platform manifest. */
  imageDownloadSizeBytes: number;
  /** Size of the pinned Hugging Face snapshot used for cache preflight. */
  modelDownloadSizeBytes?: number;
  /** Maximum time to wait for this model to become ready after launch. */
  loadTimeoutSec?: number;
  /** Additional `docker run` arguments required by this recipe. */
  dockerRunArgs?: readonly string[];
}

export const NEMOTRON_ULTRA_STATION_IMAGE = {
  tag: "vllm/vllm-openai:v0.22.0",
  arm64: {
    ref: "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
    downloadSizeBytes: 10_670_087_425,
  },
} as const;

export interface VllmModelDef {
  /** Hugging Face model id (also passed to `vllm serve`). */
  id: string;
  /** Human-readable label shown in wizard summaries. */
  label: string;
  /** Stable identifier accepted via `NEMOCLAW_VLLM_MODEL`. */
  envValue: string;
  /** Approximate full Hugging Face repository file size in bytes. */
  downloadSizeBytes: number;
  /** `--max-model-len` flag value. */
  maxModelLen: number;
  /** Immutable Hugging Face revision used for download and serving. */
  revision?: string;
  /** Stable model name exposed by the local OpenAI-compatible endpoint. */
  servedModelId?: string;
  /** Model-specific flags appended after the shared serving flags. */
  modelArgs: string[];
  /** True when the upstream HF repo requires accepting a licence. */
  gated: boolean;
  /**
   * Platforms whose interactive picker should offer this entry. Models with
   * platform-specific flags (the NVFP4 MoE checkpoint targets `sm_121a` only,
   * the very large V4 Flash recipe wants Station-class VRAM) appear only on
   * profiles they can actually run on. Direct `NEMOCLAW_VLLM_MODEL`
   * overrides normally bypass the picker filter, but a model-specific runtime
   * is rejected outside this list so an incompatible image is never pulled.
   */
  platforms: readonly VllmPlatform[];
  /**
   * Environment variables exported immediately before `vllm serve` (e.g.
   * FlashInfer / MoE-backend selection, target SM arch). Joined as
   * `export K=V && …` so they apply to the serve process inside the
   * container shell.
   */
  serveEnv?: Record<string, string>;
  /** Runtime overrides for recipes that cannot use the platform image. */
  runtime?: VllmRuntimeOverride;
  /** Whether startup must install vLLM's fastsafetensors extra. Defaults to true. */
  installFastSafetensors?: boolean;
}

export const VLLM_MODELS: readonly VllmModelDef[] = [
  {
    id: "Qwen/Qwen3.6-27B-FP8",
    label: "Qwen3.6 27B FP8",
    envValue: "qwen3.6-27b",
    downloadSizeBytes: 30_900_000_000,
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
    downloadSizeBytes: 141_000_000_000,
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
    downloadSizeBytes: 5_280_000_000,
    // Matches the model card's `max_position_embeddings` and the vLLM
    // example NVIDIA publishes for this checkpoint. The previous value
    // (262000) was an undocumented round-down with no headroom rationale.
    maxModelLen: 262144,
    // `--enable-auto-tool-choice` + `--tool-call-parser qwen3_coder` match
    // the vLLM launch example on the model card at
    // https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8. Without
    // them a plain completion succeeds (HTTP 200) but any agent request
    // that sends `tool_choice: "auto"` fails HTTP 400 with vLLM's
    // "'auto' tool choice requires --enable-auto-tool-choice and
    // --tool-call-parser to be set" (#6314) — which blocks every agent
    // tool-call flow on the generic-Linux managed vLLM default (Spark and
    // Station defaults already pin their own tool-call parser).
    //
    // `--reasoning-parser nemotron_v3` is likewise part of that same model
    // card launch recipe: Nemotron-3-Nano is a reasoning model that emits a
    // `<think>…</think>` trace. Without a reasoning parser vLLM leaves the
    // trace — including the bare `</think>` marker the chat template does not
    // pair with an opening `<think>` — inline in `content`, and the agent's
    // streaming parser mishandles that orphan marker into an empty turn that
    // wedges the session (#6915). `nemotron_v3` is a built-in parser in the
    // pinned NGC vLLM image (it subclasses the DeepSeek-R1 parser) and moves
    // the trace out of `content`, so no plugin file is required. The Spark and
    // Station defaults already pin their own reasoning parser.
    modelArgs: [
      "--gpu-memory-utilization",
      "0.7",
      "--reasoning-parser",
      "nemotron_v3",
      "--load-format",
      "fastsafetensors",
      "--enable-auto-tool-choice",
      "--tool-call-parser",
      "qwen3_coder",
    ],
    gated: false,
    platforms: ["spark", "station", "linux"],
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    label: "DeepSeek V4 Flash",
    envValue: "deepseek-v4-flash",
    downloadSizeBytes: 352_381_000_000,
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
      `'{"method":"mtp","num_speculative_tokens":3}'`,
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
    id: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    label: "NVIDIA Nemotron 3 Ultra 550B NVFP4",
    envValue: "nemotron-3-ultra-550b-a55b",
    downloadSizeBytes: 352_381_245_521,
    maxModelLen: 262144,
    revision: "183968f87ae4cedce3039313cac1fd43d112c578",
    // Keep the route identity aligned with NemoClaw's existing managed
    // Nemotron Ultra compatibility manifests and request adapters.
    servedModelId: "nvidia/nemotron-3-ultra-550b-a55b",
    modelArgs: [
      "--host",
      "0.0.0.0",
      "--cpu-offload-gb",
      "150",
      "--cpu-offload-params",
      "experts",
      "--kernel_config",
      `'{"enable_flashinfer_autotune": false}'`,
      "--speculative-config",
      `'{"method":"nemotron_h_mtp","num_speculative_tokens":3}'`,
      "--max-num-seqs",
      "256",
      "--gpu-memory-utilization",
      "0.9",
      "--reasoning-parser",
      "nemotron_v3",
      "--enable-auto-tool-choice",
      "--tool-call-parser",
      "qwen3_coder",
      "--default-chat-template-kwargs",
      `'{"enable_thinking":true,"force_nonempty_content":true}'`,
    ],
    gated: false,
    platforms: ["station"],
    serveEnv: {
      VLLM_WEIGHT_OFFLOADING_DISABLE_PIN_MEMORY: "1",
      VLLM_NVFP4_GEMM_BACKEND: "flashinfer-trtllm",
    },
    runtime: {
      image: NEMOTRON_ULTRA_STATION_IMAGE.arm64.ref,
      imageDownloadSizeBytes: NEMOTRON_ULTRA_STATION_IMAGE.arm64.downloadSizeBytes,
      modelDownloadSizeBytes: 352_381_245_521,
      loadTimeoutSec: 3600,
      // Keep NemoClaw's bridge-networked local-inference boundary instead of
      // importing the playbook's host-network setting.
      dockerRunArgs: ["--shm-size", "16g", "--ulimit", "memlock=-1", "--ulimit", "stack=67108864"],
    },
    // The digest-pinned vLLM image already contains the serving package, and
    // this recipe does not use the fastsafetensors load format. Avoid mutating
    // the reviewed runtime from the package index when the container starts.
    installFastSafetensors: false,
  },
  {
    id: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    label: "Qwen3.6 35B-A3B NVFP4",
    envValue: "qwen3.6-35b-a3b-nvfp4",
    downloadSizeBytes: 23_500_000_000,
    maxModelLen: 262144,
    // Additive flags on top of the shared serving defaults. The shared flags
    // already cover --tensor-parallel-size/--pipeline-parallel-size/
    // --data-parallel-size (all 1 — harmless on a single Spark node),
    // --port 8000, and --trust-remote-code; --max-model-len comes from
    // maxModelLen above.
    modelArgs: [
      "--gpu-memory-utilization",
      "0.4",
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
      // `qwen3_coder`, not `qwen3_xml` (#6457). On DGX Spark this checkpoint's
      // tool-call frames do not round-trip through vLLM's `qwen3_xml` parser: it
      // logs `qwen3xml_tool_parser.py:303 Error when parsing XML elements: not
      // well-formed (invalid token)` and emits truncated/extra-`}` tool
      // arguments, so Deep Agents Code headless (`dcode -n`) tool calls fail
      // with `POST /v1/chat/completions 400 Bad Request`
      // (`json.decoder.JSONDecodeError: Extra data`) and `dcode` exits 1.
      // `qwen3_coder` matches this Qwen3.6-family checkpoint's emitted tool-call
      // format — the parser the other Qwen3.6 recipes in this registry already
      // use (Qwen3.6-27B-FP8, Nemotron-3-Nano-4B). Validated end-to-end on real
      // DGX Spark (GB10); see PR verification notes for the `dcode -n` transcript.
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
 * the per-platform profile default (Station prefers DeepSeek V4 Flash, Spark
 * the Qwen3.6-35B-A3B NVFP4 checkpoint, and the generic Linux profile prefers
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
 * By default the command is prefixed with the `pip install` that pulls the
 * `fastsafetensors` extra so existing express scripts keep working. A pinned
 * runtime that already contains everything its recipe needs may disable that
 * mutation with `installFastSafetensors: false`; a model may also prepend env
 * exports via `serveEnv`.
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
    ...(model.revision ? ["--revision", model.revision] : []),
    ...(model.servedModelId ? ["--served-model-name", model.servedModelId] : []),
    ...model.modelArgs,
  ];
  const extraArgs = parseVllmExtraServeArgs(env).map(shellQuote);
  const setup =
    model.installFastSafetensors === false ? "" : "pip install vllm[fastsafetensors] && ";
  return `${envPrefix}${setup}vllm serve ${model.id} ${[...args, ...extraArgs].join(" ")}`;
}
