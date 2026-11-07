// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { downloadPinnedAsset } from "./native-inference-download.mts";
import {
  captureNative,
  hardwareCatalog,
  installLayout,
  nativeHostEnvironment,
} from "./native-inference-host.mts";
import {
  NATIVE_EXPRESS,
  cudaDeviceFromListing,
  type ProgressSink,
} from "./native-inference-manifest.mts";

export async function prepareNativeFiles(
  installRoot: string,
  stateRoot: string,
  signal: AbortSignal,
  onProgress: ProgressSink,
) {
  const catalog = await hardwareCatalog(installRoot, signal);
  if (!catalog.eligible) throw new Error(catalog.reasons.join(" "));
  const layout = installLayout(installRoot);
  const cache = path.join(stateRoot, "downloads");
  if (!fs.existsSync(cache)) fs.mkdirSync(cache);
  if (!fs.lstatSync(cache).isDirectory() || fs.lstatSync(cache).isSymbolicLink())
    throw new Error("The managed inference cache must be an ordinary private directory.");
  const runtimeArchive = await downloadPinnedAsset(
    NATIVE_EXPRESS.runtime,
    cache,
    signal,
    onProgress,
  );
  const cudaArchive = await downloadPinnedAsset(NATIVE_EXPRESS.cuda, cache, signal, onProgress);
  const runtimeRoot = path.join(stateRoot, `runtime-${randomUUID()}`);
  try {
    onProgress({
      schemaVersion: 1,
      event: "progress",
      phase: "unpacking",
      message: "Preparing the verified Windows ARM64 CUDA runtime",
    });
    const unpack = await captureNative(
      layout.python,
      [
        path.join(layout.root, "qualification", "native-inference-unpack.py"),
        runtimeArchive,
        cudaArchive,
        runtimeRoot,
      ],
      { signal, timeoutMs: 180_000, maxBytes: 32_768 },
    );
    const receipt = JSON.parse(unpack);
    if (receipt.schemaVersion !== 1 || receipt.architecture !== "arm64")
      throw new Error("The native CUDA runtime failed its architecture check.");
    const executable = path.join(runtimeRoot, "llama-server.exe");
    const environment = nativeHostEnvironment({
      PATH: `${runtimeRoot};${path.join(layout.systemRoot, "System32")};${layout.systemRoot}`,
    });
    onProgress({
      schemaVersion: 1,
      event: "progress",
      phase: "checking",
      message: "Checking native CUDA execution before the model download",
    });
    const device = cudaDeviceFromListing(
      await captureNative(executable, ["--list-devices"], {
        signal,
        timeoutMs: 60_000,
        environment,
        cwd: runtimeRoot,
      }),
    );
    const modelPath = await downloadPinnedAsset(NATIVE_EXPRESS.weights, cache, signal, onProgress);
    return { executable, runtimeRoot, environment, modelPath, device, hardware: catalog.hardware };
  } catch (error) {
    // This unique directory contains only this operation's extracted, pinned
    // executables. The persistent model cache and agent data are retained.
    await fs.promises.rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}
