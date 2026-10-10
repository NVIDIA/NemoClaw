// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";

const generatedFiles = ["openshell-gateway.toml", "jwt/signing.pem", "jwt/public.pem", "jwt/kid"];
const runtimeFiles = ["openshell.db", "runtime.json"];
const preparations = new Map<string, { endpoint: string; fingerprint: string }>();

function stateEntries(stateDir: string): string[] {
  try {
    return fs.readdirSync(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function hasNoRuntime(stateDir: string): boolean {
  const entries = stateEntries(stateDir);
  return runtimeFiles.every((file) => !entries.includes(file));
}

function fingerprint(stateDir: string): string | null {
  try {
    const digest = createHash("sha256");
    for (const directory of [stateDir, path.join(stateDir, "jwt")]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory()) return null;
      digest.update(JSON.stringify([stat.dev, stat.ino, stat.uid, stat.mode]));
    }
    if (
      fs.readdirSync(path.join(stateDir, "jwt")).sort().join(",") !== "kid,public.pem,signing.pem"
    )
      return null;
    for (const file of generatedFiles) {
      const filePath = path.join(stateDir, file);
      const opened = openRegularFileNoFollow(filePath);
      try {
        const stat = opened.stat();
        digest.update(JSON.stringify([file, stat.dev, stat.ino, stat.uid, stat.mode, stat.size]));
        digest.update(opened.readBytes(65_536));
      } finally {
        opened.close();
      }
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

/** Keep creation authority across this process's own config preparation, never across invocations. */
export function prepareNativeGatewayCreation<T>(
  stateDir: string,
  endpoint: string,
  prepare: () => T,
): T {
  const root = path.resolve(stateDir);
  const prior = preparations.get(root);
  preparations.delete(root);
  const fresh = prior
    ? prior.endpoint === endpoint && prior.fingerprint === fingerprint(root) && hasNoRuntime(root)
    : !stateEntries(root).some((file) =>
        [...runtimeFiles, "openshell-gateway.toml", "jwt"].includes(file),
      );
  // A thrown preparation leaves no authority, including after a partial write.
  const result = prepare();
  const prepared = fresh && endpoint && hasNoRuntime(root) ? fingerprint(root) : null;
  if (prepared) preparations.set(root, { endpoint, fingerprint: prepared });
  return result;
}

/** Consume only the exact prepared state; the returned check remains valid after runtime startup. */
export function consumeNativeGatewayCreation(
  stateDir: string,
  endpoint: string,
): (() => boolean) | undefined {
  const root = path.resolve(stateDir);
  const prepared = preparations.get(root);
  preparations.delete(root);
  if (
    !prepared ||
    prepared.endpoint !== endpoint ||
    !hasNoRuntime(root) ||
    prepared.fingerprint !== fingerprint(root)
  )
    return undefined;
  return () => prepared.fingerprint === fingerprint(root);
}
