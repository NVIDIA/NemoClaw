// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

const MAX_CREDENTIAL_BYTES = 4096;
const MIN_CREDENTIAL_BYTES = 32;

/** Validate the ownership, mode, type, and size of one credential descriptor. */
export function validatePrivateCredentialDescriptor(stat: fs.Stats, label: string): void {
  if (!stat.isFile()) throw new Error(`${label} descriptor is not a regular file.`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} descriptor must not be accessible by group or others.`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} descriptor is not owned by the current user.`);
  }
  if (stat.size < MIN_CREDENTIAL_BYTES || stat.size > MAX_CREDENTIAL_BYTES + 1) {
    throw new Error(`${label} descriptor has an invalid size.`);
  }
}

/** Validate one bounded printable bearer value without including it in diagnostics. */
function validateBearer(value: string, label: string): void {
  const bytes = Buffer.byteLength(value);
  if (
    bytes < MIN_CREDENTIAL_BYTES ||
    bytes > MAX_CREDENTIAL_BYTES ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new Error(`${label} is malformed.`);
  }
}

/** Trusted launcher's fixed bearer-descriptor role mapping. */
export interface PrivateBearerDescriptors {
  readonly deployment: number;
  readonly openClaw: number;
}

/** Read one credential descriptor once and validate its complete contents. */
function readBearer(descriptor: number, label: string): string {
  const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 2);
  const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
  if (bytesRead > MAX_CREDENTIAL_BYTES + 1) {
    throw new Error(`${label} descriptor has an invalid size.`);
  }
  const contents = buffer.subarray(0, bytesRead).toString("utf8");
  const value = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  validateBearer(value, label);
  return value;
}

/** Validate one inherited descriptor and return its identity-bearing metadata. */
function validateDescriptor(descriptor: number, label: string): fs.Stats {
  if (!Number.isInteger(descriptor) || descriptor < 0) {
    throw new Error(`${label} descriptor is invalid.`);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    validatePrivateCredentialDescriptor(stat, label);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADF") {
      throw new Error(`${label} descriptor is not open.`);
    }
    throw error;
  }
}

/** Read and close the two fixed startup descriptors before the gateway can accept traffic. */
export function readPrivateBearerDescriptors(descriptors: PrivateBearerDescriptors): {
  deploymentCredential: string;
  openClawCredential: string;
} {
  const uniqueDescriptors = [...new Set([descriptors.deployment, descriptors.openClaw])];
  let result: { deploymentCredential: string; openClawCredential: string } | undefined;
  let operationError: { readonly value: unknown } | undefined;
  try {
    const deploymentStat = validateDescriptor(
      descriptors.deployment,
      "Voice gateway deployment credential",
    );
    const openClawStat = validateDescriptor(
      descriptors.openClaw,
      "Voice gateway OpenClaw credential",
    );
    if (
      descriptors.deployment === descriptors.openClaw ||
      (deploymentStat.dev === openClawStat.dev && deploymentStat.ino === openClawStat.ino)
    ) {
      throw new Error("Voice gateway credential descriptors must refer to different files.");
    }
    result = {
      deploymentCredential: readBearer(
        descriptors.deployment,
        "Voice gateway deployment credential",
      ),
      openClawCredential: readBearer(descriptors.openClaw, "Voice gateway OpenClaw credential"),
    };
  } catch (error) {
    operationError = { value: error };
  }

  let cleanupError: unknown;
  for (const descriptor of uniqueDescriptors) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBADF" && cleanupError === undefined) {
        cleanupError = error;
      }
    }
  }

  if (operationError !== undefined) throw operationError.value;
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
}
