// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  readConfigFile,
  resolveHostConfigStateDir,
  writeConfigFile,
} from "../../../state/config-io";

const SCHEMA_VERSION = 1;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/u;
const PROVIDER_TYPE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const PROVIDER_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const RECOVERY_DIRECTORY = "managed-clone-provider-recovery";

export interface ManagedCloneProviderRecoveryBinding {
  readonly providerName: string;
  readonly providerType: string;
  readonly providerEnvKey: string;
  readonly sourceCredentialEnvKey?: string;
  readonly source: string;
}

export interface ManagedCloneProviderRecoveryRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly transactionId: string;
  readonly destinationSandboxName: string;
  readonly providers: readonly ManagedCloneProviderRecoveryBinding[];
}

export interface ManagedCloneProviderRecoveryStore {
  load(destinationSandboxName: string): ManagedCloneProviderRecoveryRecord | null;
  persist(record: ManagedCloneProviderRecoveryRecord): void;
  clear(record: ManagedCloneProviderRecoveryRecord): boolean;
}

interface ManagedCloneProviderRecoveryDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly recovery: ManagedCloneProviderRecoveryRecord | null;
}

export interface ManagedCloneProviderRecoveryValidators {
  readonly isValidSandboxName: (value: unknown) => value is string;
  readonly isValidProviderName: (value: unknown) => value is string;
}

const EMPTY_DOCUMENT: ManagedCloneProviderRecoveryDocument = {
  schemaVersion: SCHEMA_VERSION,
  recovery: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBinding(
  value: unknown,
  validators: ManagedCloneProviderRecoveryValidators,
): ManagedCloneProviderRecoveryBinding | null {
  if (!isRecord(value)) return null;
  if (
    !validators.isValidProviderName(value.providerName) ||
    typeof value.providerType !== "string" ||
    !PROVIDER_TYPE_PATTERN.test(value.providerType) ||
    typeof value.providerEnvKey !== "string" ||
    !PROVIDER_ENV_KEY_PATTERN.test(value.providerEnvKey) ||
    (value.sourceCredentialEnvKey !== undefined &&
      (typeof value.sourceCredentialEnvKey !== "string" ||
        !PROVIDER_ENV_KEY_PATTERN.test(value.sourceCredentialEnvKey))) ||
    typeof value.source !== "string" ||
    value.source.trim() === "" ||
    value.source !== value.source.trim() ||
    Buffer.byteLength(value.source, "utf8") > 128
  ) {
    return null;
  }
  return {
    providerName: value.providerName,
    providerType: value.providerType,
    providerEnvKey: value.providerEnvKey,
    ...(value.sourceCredentialEnvKey === undefined
      ? {}
      : { sourceCredentialEnvKey: value.sourceCredentialEnvKey }),
    source: value.source,
  };
}

function parseRecovery(
  value: unknown,
  validators: ManagedCloneProviderRecoveryValidators,
): ManagedCloneProviderRecoveryRecord | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.transactionId !== "string" ||
    !TRANSACTION_ID_PATTERN.test(value.transactionId) ||
    !validators.isValidSandboxName(value.destinationSandboxName) ||
    !Array.isArray(value.providers)
  ) {
    return null;
  }
  const providers = value.providers.map((provider) => parseBinding(provider, validators));
  if (
    providers.includes(null) ||
    new Set(providers.map((provider) => provider?.providerName)).size !== providers.length
  ) {
    return null;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    transactionId: value.transactionId,
    destinationSandboxName: value.destinationSandboxName,
    providers: providers as ManagedCloneProviderRecoveryBinding[],
  };
}

function recoveryFile(
  stateDir: string,
  destinationSandboxName: string,
  validators: ManagedCloneProviderRecoveryValidators,
): string {
  if (!validators.isValidSandboxName(destinationSandboxName)) {
    throw new Error("Managed clone provider recovery destination is invalid.");
  }
  return path.join(stateDir, RECOVERY_DIRECTORY, `${destinationSandboxName}.json`);
}

function loadDocument(
  stateDir: string,
  destinationSandboxName: string,
  validators: ManagedCloneProviderRecoveryValidators,
): ManagedCloneProviderRecoveryDocument {
  const value = readConfigFile<unknown>(
    recoveryFile(stateDir, destinationSandboxName, validators),
    EMPTY_DOCUMENT,
  );
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Managed clone provider recovery state has an unsupported schema.");
  }
  if (value.recovery === null) return EMPTY_DOCUMENT;
  const recovery = parseRecovery(value.recovery, validators);
  if (!recovery || recovery.destinationSandboxName !== destinationSandboxName) {
    throw new Error("Managed clone provider recovery state is invalid; clone remains blocked.");
  }
  return { schemaVersion: SCHEMA_VERSION, recovery };
}

/** Build a durable, destination-scoped recovery store containing no credential values. */
export function createManagedCloneProviderRecoveryStore(
  validators: ManagedCloneProviderRecoveryValidators,
  stateDir: string = resolveHostConfigStateDir(),
): ManagedCloneProviderRecoveryStore {
  const load = (destinationSandboxName: string) =>
    loadDocument(stateDir, destinationSandboxName, validators).recovery;
  return {
    load,
    persist(record) {
      const normalized = parseRecovery(record, validators);
      if (!normalized || !isDeepStrictEqual(normalized, record)) {
        throw new Error("Cannot persist invalid managed clone provider recovery state.");
      }
      const current = load(record.destinationSandboxName);
      if (current && !isDeepStrictEqual(current, normalized)) {
        throw new Error("Another managed clone provider recovery transaction is unresolved.");
      }
      writeConfigFile(recoveryFile(stateDir, record.destinationSandboxName, validators), {
        schemaVersion: SCHEMA_VERSION,
        recovery: normalized,
      });
      if (!isDeepStrictEqual(load(record.destinationSandboxName), normalized)) {
        throw new Error("Managed clone provider recovery state did not survive durable readback.");
      }
    },
    clear(record) {
      const current = load(record.destinationSandboxName);
      if (current === null) return true;
      if (!isDeepStrictEqual(current, record)) return false;
      writeConfigFile(
        recoveryFile(stateDir, record.destinationSandboxName, validators),
        EMPTY_DOCUMENT,
      );
      return load(record.destinationSandboxName) === null;
    },
  };
}
