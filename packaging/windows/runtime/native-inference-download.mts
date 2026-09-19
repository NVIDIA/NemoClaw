// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PinnedAsset, ProgressSink } from "./native-inference-manifest.mts";

export async function* responseChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs.hf.co",
  "cdn-lfs-us-1.hf.co",
  "cas-bridge.xethub.hf.co",
  "us.aws.cdn.hf.co",
  "eu.aws.cdn.hf.co",
]);

export function allowedDownloadUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !DOWNLOAD_HOSTS.has(url.hostname)
  )
    throw new Error("The managed inference download redirected outside its approved HTTPS hosts.");
  return url;
}

export async function verifyPinnedFile(
  file: string,
  asset: PinnedAsset,
  signal: AbortSignal,
  onProgress: ProgressSink,
): Promise<void> {
  signal.throwIfAborted();
  const handle = await fs.promises.open(file, "r");
  try {
    // Open first and inspect that descriptor before reading any bytes. The path
    // must still name this ordinary, singly linked file rather than a symlink.
    const opened = await handle.stat();
    const named = await fs.promises.lstat(file);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== asset.bytes ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1 ||
      named.size !== opened.size ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error(`The cached ${asset.name} is not the expected ordinary file.`);
    const hash = createHash("sha256");
    let bytes = 0;
    let last = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      signal.throwIfAborted();
      hash.update(chunk);
      bytes += chunk.length;
      if (Date.now() - last >= 250 || bytes === asset.bytes) {
        last = Date.now();
        onProgress({
          schemaVersion: 1,
          event: "progress",
          phase: "verifying",
          message: `Checking ${asset.name}`,
          asset: asset.name,
          completedBytes: bytes,
          totalBytes: asset.bytes,
        });
      }
    }
    const after = await handle.stat();
    const namedAfter = await fs.promises.lstat(file);
    if (
      bytes !== asset.bytes ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      !namedAfter.isFile() ||
      namedAfter.isSymbolicLink() ||
      namedAfter.nlink !== 1 ||
      namedAfter.dev !== opened.dev ||
      namedAfter.ino !== opened.ino ||
      hash.digest("hex") !== asset.sha256
    )
      throw new Error(`The SHA-256 verification failed for ${asset.name}.`);
  } finally {
    await handle.close();
  }
}

async function downloadResponse(
  asset: PinnedAsset,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<Response> {
  let url = allowedDownloadUrl(asset.url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await request(url, {
      redirect: "manual",
      signal,
      headers: { "accept-encoding": "identity", "user-agent": "NemoClaw-Native-Express/1" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("The managed inference download returned an empty redirect.");
      url = allowedDownloadUrl(new URL(location, url).href);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`The ${asset.name} download failed (HTTP ${response.status}).`);
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== asset.bytes) {
      await response.body.cancel();
      throw new Error(`The ${asset.name} download has an unexpected size.`);
    }
    return response;
  }
  throw new Error("The managed inference download exceeded its redirect limit.");
}

export async function downloadPinnedAsset(
  asset: PinnedAsset,
  directory: string,
  signal: AbortSignal,
  onProgress: ProgressSink,
  request: typeof fetch = fetch,
): Promise<string> {
  if (
    !/^[A-Za-z0-9_.-]+$/u.test(asset.name) ||
    /^\.+$/u.test(asset.name) ||
    !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1
  )
    throw new Error("The managed inference asset pin is invalid.");
  const file = path.join(directory, asset.name);
  try {
    await verifyPinnedFile(file, asset, signal, onProgress);
    return file;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Preserve a corrupted managed artifact for diagnosis; never overwrite an
      // existing cache entry through a link or erase unrelated user data.
      await fs.promises.rename(file, path.join(directory, `corrupt-${randomUUID()}-${asset.name}`));
    }
  }
  const partial = path.join(directory, `.download-${randomUUID()}`);
  try {
    const response = await downloadResponse(asset, signal, request);
    const hash = createHash("sha256");
    let bytes = 0;
    let last = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > asset.bytes) {
          callback(new Error("The managed inference download exceeded its pinned size."));
          return;
        }
        hash.update(chunk);
        if (Date.now() - last >= 250 || bytes === asset.bytes) {
          last = Date.now();
          onProgress({
            schemaVersion: 1,
            event: "progress",
            phase: "downloading",
            message: `Downloading ${asset.name}`,
            asset: asset.name,
            completedBytes: bytes,
            totalBytes: asset.bytes,
          });
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(responseChunks(response.body!)),
      meter,
      fs.createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256)
      throw new Error(`The SHA-256 verification failed for downloaded ${asset.name}.`);
    const handle = await fs.promises.open(partial, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(partial, file);
    onProgress({
      schemaVersion: 1,
      event: "progress",
      phase: "verifying",
      message: `Verified ${asset.name}`,
      asset: asset.name,
      completedBytes: bytes,
      totalBytes: asset.bytes,
    });
    return file;
  } catch (error) {
    await fs.promises.unlink(partial).catch(() => undefined);
    throw error;
  }
}
