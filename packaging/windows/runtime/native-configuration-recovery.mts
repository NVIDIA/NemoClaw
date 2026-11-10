// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  nativeCredentialBinding,
  readOpenedRegularFile,
  type NativeCredentialIdentity,
} from "./native-security.mts";

const FILE = "native-configuration-pending.json";
type Recovery = {
  schemaVersion: 1;
  kind: "native-configuration-pending";
  agent: string;
  operationId: string;
  writerProcessId: number;
  identities: NativeCredentialIdentity[];
};

// This record contains no credential values. Process IDs are diagnostics, never authority
// to terminate a process or release the shared configuration/state owner.
export function readNativeConfigurationRecovery(directory: string, agent: string): Recovery | null {
  const text = readOpenedRegularFile(path.join(directory, FILE), {
    encoding: "utf8",
    maxBytes: 16 * 1024,
    rejectLinks: true,
    rejectHardLinks: true,
  });
  if (text === null) return null;
  let record: Recovery;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(
      "The pending configuration record is invalid. Open NemoClaw Setup for recovery.",
    );
  }
  if (
    !record ||
    Object.keys(record).length !== 6 ||
    record.schemaVersion !== 1 ||
    record.kind !== "native-configuration-pending" ||
    record.agent !== agent ||
    !["openclaw", "hermes"].includes(agent) ||
    typeof record.operationId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(record.operationId) ||
    !Number.isSafeInteger(record.writerProcessId) ||
    record.writerProcessId <= 0 ||
    !Array.isArray(record.identities) ||
    record.identities.length > 16
  )
    throw new Error(
      "The pending configuration record is invalid. Open NemoClaw Setup for recovery.",
    );
  for (const identity of record.identities) {
    if (!identity || Object.keys(identity).length !== 3 || identity.agent !== agent)
      throw new Error("The pending configuration credential owner is invalid.");
    nativeCredentialBinding(identity);
  }
  return record;
}

export function beginNativeConfigurationRecovery(
  directory: string,
  agent: string,
  identities: NativeCredentialIdentity[],
  assertHeld: () => void,
): Recovery {
  assertHeld();
  const previous = readNativeConfigurationRecovery(directory, agent);
  const admitted = new Map<string, NativeCredentialIdentity>();
  for (const identity of [...(previous?.identities ?? []), ...identities]) {
    if (identity.agent !== agent)
      throw new Error("The pending configuration credential owner is invalid.");
    admitted.set(nativeCredentialBinding(identity), {
      agent,
      inference: identity.inference,
      endpoint: identity.endpoint,
    });
  }
  if (admitted.size > 16)
    throw new Error(
      "Too many unfinished provider changes. Remove this agent's data before reconfiguring it.",
    );
  const record: Recovery = {
    schemaVersion: 1,
    kind: "native-configuration-pending",
    agent,
    operationId: randomBytes(16).toString("hex"),
    writerProcessId: process.pid,
    identities: [...admitted.values()],
  };
  const serialized = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024)
    throw new Error("The pending configuration record exceeds its size limit.");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${FILE}.${record.operationId}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, serialized);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    assertHeld();
    fs.renameSync(temporary, path.join(directory, FILE));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return record;
}

export function completeNativeConfigurationRecovery(
  directory: string,
  record: Recovery,
  assertHeld: () => void,
) {
  assertHeld();
  if (readNativeConfigurationRecovery(directory, record.agent)?.operationId !== record.operationId)
    throw new Error("Configuration recovery ownership changed before completion.");
  fs.unlinkSync(path.join(directory, FILE));
}
