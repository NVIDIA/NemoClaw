// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import catalog from "./native-local-models.json" with { type: "json" };
import {
  allowedDownloadUrl,
  downloadPinnedAsset,
  verifyPinnedFile,
} from "./native-inference-download.mts";
import {
  NATIVE_EXPRESS,
  type PinnedAsset,
  type ProgressSink,
} from "./native-inference-manifest.mts";

export type LocalModel = {
  id: string;
  displayName: string;
  repository: string;
  revision: string;
  quantization: string;
  weights: PinnedAsset;
  visionProjector: PinnedAsset;
};

function validateAsset(asset: PinnedAsset, model: LocalModel): PinnedAsset {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$/u.test(asset.name) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    !/^[a-f0-9]{64}$/u.test(asset.sha256)
  )
    throw new Error("The local model asset pin is invalid.");
  const url = allowedDownloadUrl(asset.url);
  const prefix = `https://huggingface.co/${model.repository}/resolve/${model.revision}/`;
  if (
    url.search ||
    !url.href.startsWith(prefix) ||
    !/^[A-Za-z0-9_.-]+\.gguf$/u.test(url.href.slice(prefix.length))
  )
    throw new Error("The local model download must name its immutable repository revision.");
  return Object.freeze({ ...asset });
}

export function validateLocalModel(model: LocalModel): Readonly<LocalModel> {
  if (
    !/^[a-z0-9][a-z0-9.-]{0,80}$/u.test(model.id) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(model.repository) ||
    !/^[a-f0-9]{40}$/u.test(model.revision) ||
    model.weights.name === model.visionProjector.name
  )
    throw new Error("The local model identity is invalid.");
  return Object.freeze({
    ...model,
    weights: validateAsset(model.weights, model),
    visionProjector: validateAsset(model.visionProjector, model),
  });
}

const models = Object.freeze(catalog.models.map(validateLocalModel));
if (
  catalog.schemaVersion !== 1 ||
  catalog.fallbackSelection !== "explicit" ||
  new Set(models.map((model) => model.id)).size !== models.length ||
  !models.some((model) => model.id === catalog.defaultModel) ||
  !models.some((model) => model.id === catalog.fallbackModel)
)
  throw new Error("The local model catalog is invalid.");

export const NATIVE_LOCAL_MODELS = Object.freeze({
  defaultModel: catalog.defaultModel,
  fallbackModel: catalog.fallbackModel,
  models,
});

export const NATIVE_LOCAL_ENGINE = Object.freeze({ ...catalog.engine });

export function isDownloadedLocalModel(id: unknown): id is string {
  return typeof id === "string" && models.some((model) => model.id === id);
}

export function localModelIdentityMatches(id: unknown, model: unknown): boolean {
  return (
    (id === NATIVE_EXPRESS.id && model === NATIVE_EXPRESS.model) ||
    (isDownloadedLocalModel(id) && model === id)
  );
}

export function selectLocalModel(id: string): Readonly<LocalModel> {
  const selected = models.find((model) => model.id === id);
  if (!selected) throw new Error("Choose a model from the installed local model catalog.");
  return selected;
}

export function localModelCache(stateRoot: string, model: LocalModel) {
  return path.join(stateRoot, `model-${model.id}-${model.revision}`);
}

export async function verifyLocalModelAssets(
  id: string,
  lease: { stateRoot: string; assertHeld(): void },
  signal: AbortSignal,
  progress: ProgressSink,
) {
  const model = selectLocalModel(id);
  lease.assertHeld();
  const directory = localModelCache(lease.stateRoot, model);
  const info = await fs.promises.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Run local model setup again; the model cache is unavailable.");
  const weights = path.join(directory, model.weights.name);
  const projector = path.join(directory, model.visionProjector.name);
  const report: ProgressSink = (event) => {
    lease.assertHeld();
    progress(event);
  };
  await verifyPinnedFile(weights, model.weights, signal, report);
  await verifyPinnedFile(projector, model.visionProjector, signal, report);
  lease.assertHeld();
  return { weights, projector };
}

export function downloadedModelArguments(
  model: LocalModel,
  weights: string,
  projector: string,
  port: number,
  device: string,
) {
  validateLocalModel(model);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^CUDA\d+$/u.test(device))
    throw new Error("The local model server address is invalid.");
  return [
    "--model",
    weights,
    "--mmproj",
    projector,
    "--alias",
    model.id,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--device",
    device,
    "--n-gpu-layers",
    "all",
    "--ctx-size",
    "65536",
    "--parallel",
    "1",
    "--flash-attn",
    "on",
    "--jinja",
    "--metrics",
    "--no-webui",
    "--temp",
    "1.0",
    "--top-p",
    "0.95",
    "--top-k",
    "20",
    "--min-p",
    "0.0",
  ];
}

// The caller holds the existing native inference state lease throughout setup.
// This operation downloads data only; it neither starts a server nor changes agent configuration.
export async function downloadLocalModelAssets(
  selection: LocalModel,
  lease: { stateRoot: string; assertHeld(): void },
  signal: AbortSignal,
  onProgress: ProgressSink,
  request: typeof fetch = fetch,
) {
  const model = validateLocalModel(selection);
  signal.throwIfAborted();
  lease.assertHeld();
  const directory = localModelCache(lease.stateRoot, model);
  try {
    await fs.promises.mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await fs.promises.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("The model cache must be an ordinary private directory.");
  const interrupted = new AbortController();
  const downloadSignal = AbortSignal.any([signal, interrupted.signal]);
  const progress: ProgressSink = (event) => {
    // Progress runs inside the downloader's stream transform. Abort its pipeline
    // rather than throwing from a callback or treating lost ownership as corrupt data.
    try {
      lease.assertHeld();
      onProgress(event);
    } catch (error) {
      interrupted.abort(error);
    }
  };
  // Leave room for an incomplete file and other small setup outputs. Cached
  // files are verified by the downloader, not treated as proof of readiness.
  const space = await fs.promises.statfs(directory);
  let missingBytes = 0;
  for (const asset of [model.weights, model.visionProjector]) {
    try {
      const cached = await fs.promises.lstat(path.join(directory, asset.name));
      if (!cached.isFile() || cached.isSymbolicLink() || cached.size !== asset.bytes)
        missingBytes += asset.bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missingBytes += asset.bytes;
    }
  }
  if (space.bavail * space.bsize < missingBytes + 1024 ** 3)
    throw new Error(
      "There is not enough disk space for the selected local model. Free space and retry.",
    );
  const checkedRequest: typeof fetch = async (...args) => {
    lease.assertHeld();
    return request(...args);
  };
  try {
    lease.assertHeld();
    const weights = await downloadPinnedAsset(
      model.weights,
      directory,
      downloadSignal,
      progress,
      checkedRequest,
    );
    downloadSignal.throwIfAborted();
    lease.assertHeld();
    const projector = await downloadPinnedAsset(
      model.visionProjector,
      directory,
      downloadSignal,
      progress,
      checkedRequest,
    );
    downloadSignal.throwIfAborted();
    lease.assertHeld();
    return Object.freeze({ model: model.id, revision: model.revision, weights, projector });
  } catch (error) {
    downloadSignal.throwIfAborted();
    throw error;
  }
}
