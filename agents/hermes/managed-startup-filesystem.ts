// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const GENERATED_FILES = new Set([
  "/sandbox/.hermes/managed-policy.json",
  "/sandbox/.hermes/hermes-relay-plugins.toml",
  "/sandbox/.hermes/hermes-relay-plugin-state.json",
  "/sandbox/.hermes/hermes-switchyard-v1.toml",
]);
const FIXED_ENV = { PATH: "/usr/bin:/bin", HOME: "/sandbox" };
const TIMEOUT_MS = 10_000;

function trustedExecutable(target: string): void {
  const info = fs.lstatSync(target);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    info.gid !== 0 ||
    (info.mode & 0o022) !== 0 ||
    (info.mode & 0o111) === 0
  )
    throw new Error("Hermes source cleanup requires a trusted executable");
}

function sandboxId(flag: "-u" | "-g"): number {
  const result = spawnSync("/usr/bin/id", [flag, "sandbox"], {
    env: FIXED_ENV,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  const value = result.stdout?.trim() ?? "";
  const id = Number(value);
  if (
    result.error ||
    result.status !== 0 ||
    !/^[1-9][0-9]*$/u.test(value) ||
    !Number.isSafeInteger(id)
  ) {
    throw new Error("Hermes source cleanup could not resolve the sandbox identity");
  }
  return id;
}

function identity(info: fs.BigIntStats): string {
  return JSON.stringify(
    [
      info.dev,
      info.ino,
      info.mode,
      info.nlink,
      info.uid,
      info.gid,
      info.size,
      info.mtimeNs,
      info.ctimeNs,
    ].map(String),
  );
}

// The child loses root identity before inspecting or deleting the owner's file.
// It receives metadata only; neither policy bytes nor provider credentials cross argv.
const REMOVE_AS_OWNER = String.raw`
const fs = require("node:fs");
const [target, expected, parentExpected] = process.argv.slice(1);
const identity = (s) => JSON.stringify([s.dev,s.ino,s.mode,s.nlink,s.uid,s.gid,s.size,s.mtimeNs,s.ctimeNs].map(String));
try {
  const parent = fs.lstatSync("/sandbox/.hermes", {bigint:true});
  const file = fs.lstatSync(target, {bigint:true});
  if (!parent.isDirectory() || parent.isSymbolicLink() || identity(parent) !== parentExpected ||
      !file.isFile() || file.isSymbolicLink() || file.nlink !== 1n ||
      file.uid !== BigInt(process.getuid()) || file.gid !== BigInt(process.getgid()) ||
      identity(file) !== expected) process.exit(1);
  fs.unlinkSync(target);
} catch { process.exit(1); }
`;

/** Used only by the Hermes image's shared-runtime filesystem import. */
export function unlinkHermesGeneratedFile(target: fs.PathLike): void {
  try {
    fs.unlinkSync(target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      typeof target !== "string" ||
      !GENERATED_FILES.has(target) ||
      (code !== "EACCES" && code !== "EPERM")
    )
      throw error;
  }

  trustedExecutable("/usr/bin/id");
  trustedExecutable(process.execPath);
  const uid = sandboxId("-u");
  const gid = sandboxId("-g");
  const source = fs.lstatSync(target, { bigint: true });
  const parent = fs.lstatSync("/sandbox/.hermes", { bigint: true });
  if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.nlink !== 1n ||
    source.uid !== BigInt(uid) ||
    source.gid !== BigInt(gid) ||
    (source.mode & 0o777n) !== 0o600n ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== BigInt(uid) ||
    parent.gid !== BigInt(gid) ||
    // The shipped state root is setgid/sticky 3770, owned by sandbox:sandbox.
    // Preserve that exact contract as well as private restored roots.
    ((parent.mode & 0o022n) !== 0n && (parent.mode & 0o7777n) !== 0o3770n)
  )
    throw new Error("Hermes generated source has unsafe ownership or metadata");

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      REMOVE_AS_OWNER,
      "--",
      target,
      identity(source),
      identity(parent),
    ],
    { uid, gid, env: FIXED_ENV, encoding: "utf8", timeout: TIMEOUT_MS },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Hermes generated source cleanup failed as the sandbox user");
  }
  try {
    fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Hermes generated source removal could not be verified");
  }
  throw new Error("Hermes generated source remains after cleanup");
}

// Preserve the native API for every operation except these four staging-file unlinks.
// This is a module-local build binding, not a mutation of Node's global fs object.
export default Object.create(fs, {
  unlinkSync: { value: unlinkHermesGeneratedFile, enumerable: true },
}) as typeof fs;
