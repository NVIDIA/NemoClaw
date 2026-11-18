// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { MAX_CORPORATE_CA_BYTES } from "../corporate-ca-policy";
import { validateCorporateCaPem } from "../corporate-ca-validation";

export const NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256_ENV = "NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256";
const DIRECTORY = "network-trust";

export interface GatewayNetworkTrust {
  readonly path: string;
  readonly sha256: string;
}

function ownedDirectory(directory: string, expected?: fs.Stats): fs.Stats {
  const current = fs.lstatSync(directory);
  if (
    typeof process.getuid !== "function" ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.uid !== process.getuid() ||
    (current.mode & 0o777) !== 0o700 ||
    (expected && (current.dev !== expected.dev || current.ino !== expected.ino))
  ) {
    throw new Error(
      `Gateway network trust requires an unchanged owned directory with mode 0700: ${directory}`,
    );
  }
  return current;
}

/** Only accept a certificate snapshot owned by this gateway, never an arbitrary configured path. */
export function readGatewayNetworkTrust(
  stateDir: string,
  configuredPath: unknown,
): GatewayNetworkTrust | null {
  if (configuredPath === undefined || configuredPath === null) return null;
  const directory = path.join(stateDir, DIRECTORY);
  const name = typeof configuredPath === "string" ? path.basename(configuredPath) : "";
  const digest = /^additional-ca-([a-f0-9]{64})\.pem$/u.exec(name)?.[1];
  if (
    !digest ||
    configuredPath !== path.join(directory, name) ||
    !path.isAbsolute(configuredPath)
  ) {
    throw new Error("Gateway network trust must select its owned certificate snapshot");
  }
  const state = ownedDirectory(stateDir);
  const parent = ownedDirectory(directory);
  const file = openRegularFileNoFollow(configuredPath);
  try {
    const stat = file.stat();
    if (stat.uid !== state.uid || (stat.mode & 0o777) !== 0o444) {
      throw new Error("Gateway network trust requires an owned read-only certificate snapshot");
    }
    const bytes = file.readBytes(MAX_CORPORATE_CA_BYTES);
    const normalized = validateCorporateCaPem(bytes.toString("utf8"));
    if (
      !bytes.equals(Buffer.from(normalized, "utf8")) ||
      createHash("sha256").update(bytes).digest("hex") !== digest
    ) {
      throw new Error("Gateway network trust certificate snapshot changed");
    }
    ownedDirectory(stateDir, state);
    ownedDirectory(directory, parent);
    return { path: configuredPath, sha256: digest };
  } finally {
    file.close();
  }
}

/** Retain previous generations because a running supervisor can still use their certificate paths. */
export function stageGatewayNetworkTrust(stateDir: string, pem: string): GatewayNetworkTrust {
  const normalized = validateCorporateCaPem(pem);
  const sha256 = createHash("sha256").update(normalized, "utf8").digest("hex");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = ownedDirectory(stateDir);
  const directory = path.join(stateDir, DIRECTORY);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const parent = ownedDirectory(directory);
  const target = path.join(directory, `additional-ca-${sha256}.pem`);
  const temporary = path.join(
    directory,
    `.ca-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    fs.writeFileSync(descriptor, normalized, "utf8");
    fs.fchmodSync(descriptor, 0o444);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    ownedDirectory(stateDir, state);
    ownedDirectory(directory, parent);
    try {
      // A hard link publishes complete bytes without replacing an existing generation.
      fs.linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryCreated) {
      ownedDirectory(stateDir, state);
      ownedDirectory(directory, parent);
      fs.unlinkSync(temporary);
    }
  }
  return readGatewayNetworkTrust(stateDir, target)!;
}
