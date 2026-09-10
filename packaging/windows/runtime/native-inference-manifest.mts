// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readOpenedRegularFile } from "./native-security.mts";
import { fileURLToPath } from "node:url";

type NativeExpressManifest = {
  schemaVersion: 1;
  id: string;
  displayName: string;
  productName: string;
  serverVersion: string;
  cudaVersion: string;
  model: string;
  modelRepository: string;
  modelRevision: string;
  memoryBytes: number;
  storageBytes: number;
  contextSize: number;
  maxOutputTokens: number;
  maxRequestBytes: number;
  maxHeaderBytes: number;
  requestTimeoutMs: number;
  readinessTimeoutMs: number;
  shutdownTimeoutMs: number;
  runtime: PinnedAsset;
  cuda: PinnedAsset;
  weights: PinnedAsset;
};

// Shared with the embedded WPF catalog. The packaged, immutable JSON is the
// single source for native downloads, capacity thresholds, and model settings.
const manifestText = readOpenedRegularFile(
  fileURLToPath(new URL("./native-inference-manifest.json", import.meta.url)),
  { encoding: "utf8", maxBytes: 64 * 1024 },
);
if (manifestText === null) throw new Error("The installed native inference manifest is missing.");
const manifest = JSON.parse(manifestText) as NativeExpressManifest;
if (manifest.schemaVersion !== 1)
  throw new Error("The installed native inference manifest version is invalid.");
export const NATIVE_EXPRESS = Object.freeze({
  ...manifest,
  runtime: Object.freeze(manifest.runtime),
  cuda: Object.freeze(manifest.cuda),
  weights: Object.freeze(manifest.weights),
});

export type NativeInferenceProgress = {
  schemaVersion: 1;
  event: "progress";
  phase: "checking" | "downloading" | "verifying" | "unpacking" | "loading" | "probing";
  message: string;
  asset?: string;
  completedBytes?: number;
  totalBytes?: number;
};
export type ProgressSink = (event: NativeInferenceProgress) => void;
export type PinnedAsset = { name: string; url: string; sha256: string; bytes: number };
export type NativeHardware = {
  platform: string;
  arch: string;
  product: string;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  availableStorageBytes: number;
  driverVersion: string;
  cudaVersion: string;
  gpuCount: number;
};

export function nativeEligibility(hardware: NativeHardware): string[] {
  const reasons: string[] = [];
  if (hardware.platform !== "win32" || hardware.arch !== "arm64")
    reasons.push("On-device Express requires native Windows ARM64.");
  if (!/(?:^|\s)RTX Spark N1X(?:$|\s)/iu.test(hardware.product))
    reasons.push("This Express model is offered for RTX Spark N1X hardware.");
  if (
    !Number.isFinite(hardware.totalMemoryBytes) ||
    hardware.totalMemoryBytes < NATIVE_EXPRESS.memoryBytes
  )
    reasons.push("This model requires at least 50.3 GB of system memory.");
  if (
    !Number.isFinite(hardware.availableMemoryBytes) ||
    hardware.availableMemoryBytes < NATIVE_EXPRESS.memoryBytes
  )
    reasons.push("Close other GPU and memory-intensive applications; 50.3 GB must be available.");
  if (
    !Number.isFinite(hardware.availableStorageBytes) ||
    hardware.availableStorageBytes < NATIVE_EXPRESS.storageBytes
  )
    reasons.push("At least 40 GiB of free system-drive storage is required.");
  const version = /^(\d+)\.(\d+)$/u.exec(hardware.cudaVersion);
  if (
    !version ||
    Number(version[1]) < 13 ||
    (Number(version[1]) === 13 && Number(version[2]) < 4) ||
    !/^\d+(?:\.\d+){1,3}$/u.test(hardware.driverVersion) ||
    hardware.gpuCount !== 1
  )
    reasons.push(
      "Install the N1X Windows driver with CUDA 13.4 support; one NVIDIA GPU must be visible.",
    );
  return reasons;
}

export function cudaDeviceFromListing(text: string): string {
  const devices = [...text.matchAll(/^\s*(CUDA\d+):[^\r\n]+\((\d+) MiB, (\d+) MiB free\)\s*$/gmu)];
  if (devices.length !== 1)
    throw new Error("The native CUDA runtime did not find exactly one usable GPU.");
  if (Number(devices[0][3]) * 1024 * 1024 < NATIVE_EXPRESS.memoryBytes)
    throw new Error(
      "The CUDA device does not currently have enough available memory for this model.",
    );
  return devices[0][1];
}

export function nativeServerArguments(modelPath: string, port: number, device: string): string[] {
  if (!/^CUDA\d+$/u.test(device) || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("The owned native CUDA server address is invalid.");
  return [
    "--model",
    modelPath,
    "--alias",
    NATIVE_EXPRESS.model,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--device",
    device,
    "--n-gpu-layers",
    "all",
    "--fit",
    "off",
    "--split-mode",
    "none",
    "--ctx-size",
    String(NATIVE_EXPRESS.contextSize),
    "--parallel",
    "1",
    "--batch-size",
    "2048",
    "--ubatch-size",
    "512",
    "--flash-attn",
    "on",
    "--cache-type-k",
    "f16",
    "--cache-type-v",
    "f16",
    "--jinja",
    "--chat-template-kwargs",
    '{"reasoning_strength":"low"}',
    "--n-predict",
    String(NATIVE_EXPRESS.maxOutputTokens),
    "--timeout",
    "900",
    "--sleep-idle-seconds",
    "-1",
    "--metrics",
    "--no-webui",
    "--no-slots",
    "--no-ui-mcp-proxy",
    "--no-agent",
    "--no-models-autoload",
  ];
}

export function requireFullCudaOffload(log: string): {
  offloadedLayers: number;
  totalLayers: number;
} {
  const layers = [...log.matchAll(/offloaded (\d+)\/(\d+) layers to GPU/gu)].at(-1);
  if (
    !layers ||
    Number(layers[1]) < 1 ||
    layers[1] !== layers[2] ||
    !/CUDA\d+.*model buffer size/iu.test(log)
  )
    throw new Error("The model did not prove full CUDA offload. CPU fallback is not supported.");
  return { offloadedLayers: Number(layers[1]), totalLayers: Number(layers[2]) };
}

export function guardedNativeChat(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The inference request must be an object.");
  const body = value as Record<string, unknown>;
  if (
    body.model !== NATIVE_EXPRESS.model ||
    !Array.isArray(body.messages) ||
    body.messages.length < 1
  )
    throw new Error("The request must use the selected local model and chat messages.");
  for (const message of body.messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["system", "developer", "user", "assistant", "tool"].includes(message.role)
    )
      throw new Error("The local chat message is invalid.");
    const content = message.content;
    if (
      content !== null &&
      content !== undefined &&
      typeof content !== "string" &&
      !(
        Array.isArray(content) &&
        content.every(
          (part: unknown) =>
            part !== null &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        )
      )
    )
      throw new Error(
        "This local model accepts text and tool messages; image, file, and remote-media inputs are unavailable.",
      );
  }
  const output = body.max_completion_tokens ?? body.max_tokens ?? NATIVE_EXPRESS.maxOutputTokens;
  if (!Number.isSafeInteger(output) || Number(output) < 1)
    throw new Error("The local model requires a positive output-token limit.");
  if (body.n !== undefined && body.n !== 1)
    throw new Error("The local model supports one completion per request.");
  // Agent tool descriptions remain data. Server tools, router choices, file and
  // remote-model inputs, and native server administrative controls are absent.
  const allowed = new Set([
    "model",
    "messages",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream",
    "stream_options",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "seed",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "repetition_penalty",
    "repeat_penalty",
    "response_format",
    "reasoning_effort",
    "n",
    "user",
    "store",
  ]);
  for (const key of Object.keys(body))
    if (!allowed.has(key)) throw new Error(`Unsupported local inference parameter: ${key}`);
  if (body.store !== undefined && body.store !== false)
    throw new Error("Server-side conversation storage is not enabled for this local model.");
  const { store: _store, ...request } = body;
  const limit = Math.min(Number(output), NATIVE_EXPRESS.maxOutputTokens);
  return {
    ...request,
    max_tokens: limit,
    max_completion_tokens: limit,
    parallel_tool_calls: false,
    n: 1,
  };
}
