// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { NATIVE_EXPRESS } from "./native-inference-manifest.mts";
import { readOpenedRegularFile } from "./native-security.mts";
import { withNativeRuntimeSession, type NativeRuntimeSession } from "./native-runtime.mts";

function exactKeys(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    Object.keys(value).every((name) => names.includes(name))
  );
}
function ordinarySize(file: string, expected: number) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("The prebuilt model asset is not an ordinary sealed file.");
  const descriptor = fs.openSync(file, "r");
  try {
    const current = fs.fstatSync(descriptor);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== expected
    )
      throw new Error("The prebuilt model asset differs from its installed identity.");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPrebuiltNativeModel(
  lease: Pick<
    NativeRuntimeSession,
    "runtimeRoot" | "runtimeId" | "manifestSha256" | "sourceRevision" | "assertHeld"
  >,
) {
  lease.assertHeld();
  const root = path.join(lease.runtimeRoot, "inference", NATIVE_EXPRESS.id);
  const text = readOpenedRegularFile(path.join(root, "pack.json"), {
    encoding: "utf8",
    maxBytes: 16384,
  });
  if (text === null)
    throw new Error("This distribution does not include the selected prebuilt on-device model.");
  const pack: unknown = JSON.parse(text);
  if (
    !exactKeys(pack, [
      "schemaVersion",
      "classification",
      "id",
      "model",
      "modelRevision",
      "runtimeArchiveSha256",
      "cudaArchiveSha256",
      "server",
      "weights",
    ]) ||
    pack.schemaVersion !== 1 ||
    pack.classification !== "prebuilt-native-model-pack" ||
    pack.id !== NATIVE_EXPRESS.id ||
    pack.model !== NATIVE_EXPRESS.model ||
    pack.modelRevision !== NATIVE_EXPRESS.modelRevision ||
    pack.runtimeArchiveSha256 !== NATIVE_EXPRESS.runtime.sha256 ||
    pack.cudaArchiveSha256 !== NATIVE_EXPRESS.cuda.sha256 ||
    !exactKeys(pack.server, ["file", "bytes", "sha256"]) ||
    !exactKeys(pack.weights, ["file", "bytes", "sha256"])
  )
    throw new Error("The installed model pack does not match this distribution's model catalog.");
  const server = pack.server;
  const weights = pack.weights;
  if (
    server.file !== "bin/llama-server.exe" ||
    typeof server.bytes !== "number" ||
    !Number.isSafeInteger(server.bytes) ||
    server.bytes <= 0 ||
    server.bytes > 512 * 1024 * 1024 ||
    typeof server.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(server.sha256) ||
    weights.file !== "model/" + NATIVE_EXPRESS.weights.name ||
    weights.bytes !== NATIVE_EXPRESS.weights.bytes ||
    weights.sha256 !== NATIVE_EXPRESS.weights.sha256
  )
    throw new Error("The installed model files do not match their prebuilt catalog identities.");
  const executable = path.join(root, "bin", "llama-server.exe");
  const modelPath = path.join(root, "model", NATIVE_EXPRESS.weights.name);
  ordinarySize(executable, server.bytes);
  ordinarySize(modelPath, weights.bytes as number);
  lease.assertHeld();
  return {
    root,
    runtimeRoot: path.dirname(executable),
    executable,
    modelPath,
    metadata: {
      schemaVersion: 1,
      id: NATIVE_EXPRESS.id,
      model: NATIVE_EXPRESS.model,
      modelRevision: NATIVE_EXPRESS.modelRevision,
      weightsSha256: NATIVE_EXPRESS.weights.sha256,
      weightsBytes: NATIVE_EXPRESS.weights.bytes,
      packSha256: createHash("sha256").update(text).digest("hex"),
      runtimeId: lease.runtimeId,
      runtimeManifestSha256: lease.manifestSha256,
      sourceRevision: lease.sourceRevision,
      availability: "prebuilt" as const,
      modelBytesRead: 0 as const,
    },
  };
}

export async function inspectPrebuiltNativeModel(installRoot: string, launcher: string) {
  return await withNativeRuntimeSession(
    launcher,
    installRoot,
    "inference",
    async (lease) => readPrebuiltNativeModel(lease).metadata,
  );
}
