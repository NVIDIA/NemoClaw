// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readOpenedRegularFile } from "./native-security.mts";
import { NATIVE_LOCAL_ENGINE, selectLocalModel } from "./native-local-models.mts";
import { withNativeRuntimeSession, type NativeRuntimeSession } from "./native-runtime.mts";

export function readBundledNativeEngine(
  lease: Pick<
    NativeRuntimeSession,
    "runtimeRoot" | "runtimeId" | "manifestSha256" | "sourceRevision" | "assertHeld"
  >,
) {
  lease.assertHeld();
  const root = path.join(lease.runtimeRoot, "inference", "managed");
  const text = readOpenedRegularFile(path.join(root, "runtime.json"), {
    encoding: "utf8",
    maxBytes: 65536,
  });
  if (!text) throw new Error("This installer does not include the managed llama.cpp runtime.");
  const receipt = JSON.parse(text);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.classification !== "candidate-native-inference-runtime" ||
    receipt.modelsBundled !== false ||
    !receipt.engine ||
    Object.entries(NATIVE_LOCAL_ENGINE).some(([key, value]) => receipt.engine[key] !== value) ||
    !Array.isArray(receipt.files) ||
    receipt.files.length < 1 ||
    receipt.files.length > 128
  )
    throw new Error("The bundled inference runtime differs from its catalog.");
  const names = new Set<string>();
  for (const row of receipt.files) {
    if (
      !row ||
      typeof row.path !== "string" ||
      !/^bin\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(exe|dll)$/u.test(row.path) ||
      names.has(row.path.toLowerCase()) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.sha256)
    )
      throw new Error("The bundled inference file inventory is invalid.");
    names.add(row.path.toLowerCase());
    const info = fs.lstatSync(path.join(root, row.path));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== row.bytes)
      throw new Error("A bundled inference file differs from its sealed identity.");
  }
  for (const name of [
    "llama-server.exe",
    "llama-server-impl.dll",
    "llama.dll",
    "ggml-cuda.dll",
    "cudart64_13.dll",
  ])
    if (!names.has(`bin/${name}`)) throw new Error("The bundled inference runtime is incomplete.");
  lease.assertHeld();
  return {
    executable: path.join(root, "bin", "llama-server.exe"),
    runtimeRoot: path.join(root, "bin"),
    packSha256: createHash("sha256").update(text).digest("hex"),
  };
}

export async function inspectBundledNativeModel(installRoot: string, launcher: string, id: string) {
  const model = selectLocalModel(id);
  return withNativeRuntimeSession(launcher, installRoot, "inference", async (lease) => {
    const engine = readBundledNativeEngine(lease);
    return {
      schemaVersion: 1,
      id: model.id,
      model: model.id,
      modelRevision: model.revision,
      weightsSha256: model.weights.sha256,
      weightsBytes: model.weights.bytes,
      packSha256: engine.packSha256,
      runtimeId: lease.runtimeId,
      runtimeManifestSha256: lease.manifestSha256,
      sourceRevision: lease.sourceRevision,
      availability: "download-on-setup",
      modelBytesRead: 0,
    };
  });
}
