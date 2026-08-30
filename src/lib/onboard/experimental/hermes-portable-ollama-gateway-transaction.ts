// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { checkOpenAiInferenceProviderProfile } from "../../adapters/openshell/provider-profile";
import { ensureConfigDir, rejectSymlinksOnPath } from "../../state/config-io";
import { parseGatewayProviderMetadata } from "../gateway-provider-metadata";
import type { HostLocalInferenceReceiptWriter } from "../runtime-provider/host-local-inference";
import {
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../runtime-provider/host-local-inference";
import type { HostLocalInferenceStartupSelection } from "../runtime-provider/host-local-inference-routing";
import { createHermesPortablePodmanOperationEngines } from "./hermes-portable-podman-authority";

const NETWORK_ID = /^[a-f0-9]{64}$/u;
const GATEWAY_PROVIDER_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_CREDENTIAL_ENV = /^[A-Z_][A-Z0-9_]*$/u;
const MAX_RECEIPT_BYTES = 32 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const MAX_GATEWAY_PROVIDER_OUTPUT_BYTES = 16 * 1024;
const GATEWAY_PROVIDER_PROBE_TIMEOUT_MS = 15_000;
const GATEWAY_PROVIDER_MUTATION_TIMEOUT_MS = 30_000;
const GATEWAY_PROVIDER_JOURNAL_FILE = "portable-gateway-provider.json";
const TEMPORARY_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

type GatewayCommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type HermesPortableOllamaGatewayRunner = (
  args: string[],
  options: {
    ignoreError: true;
    suppressOutput: true;
    stdio: ["ignore", "pipe", "pipe"];
    env?: NodeJS.ProcessEnv;
    timeout: number;
  },
) => GatewayCommandResult;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  return value as Record<string, unknown>;
}

function openPrivateStateFile(directory: string, fileName: string, label: string) {
  rejectSymlinksOnPath(directory);
  let directoryMetadata: fs.BigIntStats;
  try {
    directoryMetadata = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Hermes Portable inference ${label} directory is missing.`);
    }
    throw error;
  }
  const uid = BigInt(process.getuid?.() ?? directoryMetadata.uid);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    directoryMetadata.uid !== uid ||
    (directoryMetadata.mode & 0o077n) !== 0n
  ) {
    throw new Error(`Hermes Portable inference ${label} directory lacks private authority.`);
  }
  const target = path.join(directory, fileName);
  const hasRecoverablePublicationLink = (metadata: fs.BigIntStats): boolean => {
    if (metadata.nlink === 1n) return true;
    if (metadata.nlink !== 2n) return false;
    const prefix = `.${fileName}.`;
    const suffix = ".tmp";
    const candidates = fs
      .readdirSync(directory)
      .filter((entry) => {
        if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return false;
        return TEMPORARY_FILE_ID.test(entry.slice(prefix.length, -suffix.length));
      })
      .map((entry) => fs.lstatSync(path.join(directory, entry), { bigint: true }))
      .filter(
        (candidate) =>
          candidate.isFile() &&
          !candidate.isSymbolicLink() &&
          candidate.dev === metadata.dev &&
          candidate.ino === metadata.ino &&
          candidate.mode === metadata.mode &&
          candidate.nlink === metadata.nlink &&
          candidate.uid === metadata.uid &&
          candidate.gid === metadata.gid &&
          candidate.size === metadata.size &&
          candidate.mtimeNs === metadata.mtimeNs &&
          candidate.ctimeNs === metadata.ctimeNs,
      );
    return candidates.length === 1;
  };
  const readExact = (): string | null => {
    if (typeof fs.constants.O_NOFOLLOW !== "number") {
      throw new Error(`Hermes Portable inference ${label} reads require O_NOFOLLOW.`);
    }
    const nonblock = fs.constants.O_NONBLOCK ?? 0;
    let descriptor: number;
    try {
      descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        !hasRecoverablePublicationLink(before) ||
        before.uid !== uid ||
        (before.mode & 0o077n) !== 0n ||
        before.size <= 0n ||
        before.size > BigInt(MAX_RECEIPT_BYTES)
      ) {
        throw new Error(`Hermes Portable inference ${label} lacks private file authority.`);
      }
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (
        offset !== bytes.length ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink ||
        !hasRecoverablePublicationLink(after) ||
        before.uid !== after.uid ||
        before.gid !== after.gid ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new Error(`Hermes Portable inference ${label} changed during its stable read.`);
      }
      return bytes.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const publishExclusive = (serialized: string): boolean => {
    if (typeof fs.constants.O_NOFOLLOW !== "number") {
      throw new Error(`Hermes Portable inference ${label} writes require O_NOFOLLOW.`);
    }
    const temporary = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      fs.writeFileSync(descriptor, serialized, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      try {
        fs.linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      fs.unlinkSync(temporary);
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
      return true;
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  };
  const replaceExact = (expected: string, replacement: string): void => {
    if (readExact() !== expected) {
      throw new Error(`Hermes Portable inference ${label} changed before its durable update.`);
    }
    const temporary = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      fs.writeFileSync(descriptor, replacement, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      if (readExact() !== expected) {
        throw new Error(`Hermes Portable inference ${label} changed concurrently.`);
      }
      fs.renameSync(temporary, target);
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
      if (readExact() !== replacement) {
        throw new Error(`Hermes Portable inference ${label} durable update is indeterminate.`);
      }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  };
  return Object.freeze({ publishExclusive, readExact, replaceExact });
}

function createPrivateStateFile(directory: string, fileName: string, label: string) {
  ensureConfigDir(directory);
  return openPrivateStateFile(directory, fileName, label);
}

type GatewayProviderAuthority = Readonly<{
  id: string;
  resourceVersion: number;
}>;

type GatewayProviderJournalPhase =
  | "prepared"
  | "creating"
  | "created"
  | "rolling-back"
  | "rolled-back"
  | "committed";

type GatewayProviderJournalIntent = Readonly<{
  transactionId: string;
  targetSha256: string;
  gatewayName: "nemoclaw";
  sandboxName: string;
  provider: "ollama-local";
  model: string;
  type: "openai";
  credentialEnv: string;
  providerCredentialEnv: string;
  baseUrl: "http://host.openshell.internal:11434/v1";
}>;

type GatewayProviderJournal = Readonly<{
  schemaVersion: 1;
  kind: "hermes-portable-ollama-gateway-provider";
  phase: GatewayProviderJournalPhase;
  intent: GatewayProviderJournalIntent;
  providerAuthority: GatewayProviderAuthority | null;
}>;

function createGatewayProviderJournalStore(
  directory: string,
  intent: GatewayProviderJournalIntent,
  mode: "create" | "open-existing" = "create",
) {
  const stateFile = (mode === "create" ? createPrivateStateFile : openPrivateStateFile)(
    directory,
    GATEWAY_PROVIDER_JOURNAL_FILE,
    "gateway provider journal",
  );
  const serialize = (journal: GatewayProviderJournal): string => `${JSON.stringify(journal)}\n`;
  const parse = (serialized: string): GatewayProviderJournal => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Hermes Portable inference gateway provider journal is malformed.");
    }
    const record = requireRecord(parsed, "Hermes Portable inference gateway provider journal");
    const phase = record.phase;
    const authority = record.providerAuthority;
    if (
      record.schemaVersion !== 1 ||
      record.kind !== "hermes-portable-ollama-gateway-provider" ||
      typeof phase !== "string" ||
      !["prepared", "creating", "created", "rolling-back", "rolled-back", "committed"].includes(
        phase,
      ) ||
      !isDeepStrictEqual(record.intent, intent) ||
      Object.keys(record).sort().join("\n") !==
        ["schemaVersion", "kind", "phase", "intent", "providerAuthority"].sort().join("\n")
    ) {
      throw new Error("Hermes Portable inference gateway provider journal authority changed.");
    }
    let providerAuthority: GatewayProviderAuthority | null = null;
    if (authority !== null) {
      const authorityRecord = requireRecord(
        authority,
        "Hermes Portable inference gateway provider journal authority",
      );
      if (
        Object.keys(authorityRecord).sort().join("\n") !== ["id", "resourceVersion"].join("\n") ||
        typeof authorityRecord.id !== "string" ||
        !GATEWAY_PROVIDER_ID.test(authorityRecord.id) ||
        !Number.isSafeInteger(authorityRecord.resourceVersion) ||
        Number(authorityRecord.resourceVersion) < 1
      ) {
        throw new Error(
          "Hermes Portable inference gateway provider journal identity is malformed.",
        );
      }
      providerAuthority = Object.freeze({
        id: authorityRecord.id,
        resourceVersion: Number(authorityRecord.resourceVersion),
      });
    }
    if (
      (["created", "rolling-back", "committed"].includes(phase) && !providerAuthority) ||
      (["prepared", "creating"].includes(phase) && providerAuthority)
    ) {
      throw new Error("Hermes Portable inference gateway provider journal phase is inconsistent.");
    }
    const journal = Object.freeze({
      schemaVersion: 1 as const,
      kind: "hermes-portable-ollama-gateway-provider" as const,
      phase: phase as GatewayProviderJournalPhase,
      intent,
      providerAuthority,
    });
    if (serialize(journal) !== serialized) {
      throw new Error("Hermes Portable inference gateway provider journal is not canonical.");
    }
    return journal;
  };
  const load = (): GatewayProviderJournal | null => {
    const serialized = stateFile.readExact();
    return serialized === null ? null : parse(serialized);
  };
  const transition = (
    current: GatewayProviderJournal,
    phase: GatewayProviderJournalPhase,
    providerAuthority: GatewayProviderAuthority | null,
  ): GatewayProviderJournal => {
    const next = Object.freeze({ ...current, phase, providerAuthority });
    stateFile.replaceExact(serialize(current), serialize(next));
    return next;
  };
  return Object.freeze({
    load,
    prepare(current: GatewayProviderJournal | null): GatewayProviderJournal {
      const prepared = Object.freeze({
        schemaVersion: 1 as const,
        kind: "hermes-portable-ollama-gateway-provider" as const,
        phase: "prepared" as const,
        intent,
        providerAuthority: null,
      });
      if (current === null) {
        if (!stateFile.publishExclusive(serialize(prepared))) {
          throw new Error(
            "Hermes Portable inference gateway provider journal appeared concurrently.",
          );
        }
        return prepared;
      }
      if (current.phase !== "rolled-back") {
        throw new Error("Hermes Portable inference gateway provider journal is already active.");
      }
      return transition(current, "prepared", null);
    },
    transition,
    markCommitted(): void {
      const current = load();
      if (current?.phase === "committed") return;
      if (current?.phase !== "created" || !current.providerAuthority) {
        throw new Error(
          "Hermes Portable inference gateway provider publication journal is incomplete.",
        );
      }
      transition(current, "committed", current.providerAuthority);
    },
  });
}

function createReceiptWriter(
  directory: string,
  transactionId: string,
  targetSha256: string,
  markGatewayProviderCommitted: () => void,
): HostLocalInferenceReceiptWriter & {
  readonly readPublished: () => ReturnType<typeof parseHostLocalInferenceReceipt> | null;
} {
  const stateFile = createPrivateStateFile(directory, "portable-inference.json", "receipt");
  return Object.freeze({
    transactionId,
    targetSha256,
    readPublished() {
      const serialized = stateFile.readExact();
      return serialized === null ? null : parseHostLocalInferenceReceipt(serialized);
    },
    writeExact(serializedReceipt: string) {
      const canonical = serializeHostLocalInferenceReceipt(
        parseHostLocalInferenceReceipt(serializedReceipt),
      );
      if (
        canonical !== serializedReceipt ||
        Buffer.byteLength(canonical, "utf8") > MAX_RECEIPT_BYTES
      ) {
        throw new Error("Hermes Portable inference receipt exceeds its canonical boundary.");
      }
      const existing = stateFile.readExact();
      if (existing === canonical) {
        markGatewayProviderCommitted();
        return existing;
      }
      if (existing !== null) {
        throw new Error("Hermes Portable inference receipt target already has other authority.");
      }
      if (stateFile.publishExclusive(canonical)) {
        markGatewayProviderCommitted();
        return canonical;
      }
      const raced = stateFile.readExact();
      if (raced === canonical) {
        markGatewayProviderCommitted();
        return raced;
      }
      throw new Error("Hermes Portable inference receipt target changed concurrently.");
    },
  });
}

type GatewayProviderObservation =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly id: string;
      readonly resourceVersion: number;
    };

function gatewayCommandText(result: GatewayCommandResult): string {
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString("utf8")
    : (result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString("utf8")
    : (result.stderr ?? "");
  return Buffer.from(`${stdout}\n${stderr}`, "utf8")
    .subarray(0, MAX_GATEWAY_PROVIDER_OUTPUT_BYTES)
    .toString("utf8");
}

function gatewayReportsProviderAbsent(output: string, provider: string): boolean {
  const escaped = provider.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`provider\\s+['\"\`]${escaped}['\"\`]\\s+(?:was\\s+)?not found`, "iu").test(
      output,
    ) ||
    (/code:\s*['"]some requested entity was not found['"]/iu.test(output) &&
      /message:\s*['"]provider not found['"]/iu.test(output))
  );
}

function observeExactGatewayProvider(
  runGatewayOpenshell: HermesPortableOllamaGatewayRunner,
  provider: string,
  expectedProviderCredentialEnv: string,
): GatewayProviderObservation {
  const result = runGatewayOpenshell(["provider", "get", provider], {
    ignoreError: true,
    suppressOutput: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GATEWAY_PROVIDER_PROBE_TIMEOUT_MS,
  });
  const output = gatewayCommandText(result);
  if (result.status !== 0) {
    if (gatewayReportsProviderAbsent(output, provider)) return { kind: "absent" };
    throw new Error("Hermes Portable inference could not prove gateway provider absence.");
  }
  const metadata = parseGatewayProviderMetadata(output);
  const cleanOutput = stripAnsi(output);
  const ids = Array.from(cleanOutput.matchAll(/^\s*Id:\s*([A-Za-z0-9._:-]{1,128})\s*$/gimu));
  const versions = Array.from(cleanOutput.matchAll(/^\s*Resource version:\s*([0-9]+)\s*$/gimu));
  const id = ids.length === 1 ? ids[0]![1]! : "";
  const resourceVersion = versions.length === 1 ? Number(versions[0]![1]) : Number.NaN;
  if (
    !metadata ||
    metadata.name !== provider ||
    metadata.type !== "openai" ||
    metadata.credentialKeys.length !== 1 ||
    metadata.credentialKeys[0] !== expectedProviderCredentialEnv ||
    metadata.configKeys.length !== 1 ||
    metadata.configKeys[0] !== "OPENAI_BASE_URL" ||
    !GATEWAY_PROVIDER_ID.test(id) ||
    !Number.isSafeInteger(resourceVersion) ||
    resourceVersion < 1
  ) {
    throw new Error("Hermes Portable inference found ambiguous gateway provider authority.");
  }
  return { kind: "present", id, resourceVersion };
}

function exactGatewayMutation(
  runGatewayOpenshell: HermesPortableOllamaGatewayRunner,
  expectedModel: string,
  expectedSandboxName: string,
  expectedCredentialEnv: string,
  expectedProviderCredentialEnv: string,
  journalStore: ReturnType<typeof createGatewayProviderJournalStore>,
  receiptPublished: boolean,
): Readonly<{
  prepareGatewayMutation: HostLocalInferenceStartupSelection["prepareGatewayMutation"];
  recoverUnpublishedRoute: boolean;
}> {
  const readExact = (provider: string): GatewayProviderObservation =>
    observeExactGatewayProvider(runGatewayOpenshell, provider, expectedProviderCredentialEnv);
  const matchesAuthority = (
    observation: GatewayProviderObservation,
    authority: GatewayProviderAuthority,
  ): observation is Extract<GatewayProviderObservation, { kind: "present" }> =>
    observation.kind === "present" &&
    observation.id === authority.id &&
    observation.resourceVersion === authority.resourceVersion;
  const createdAuthority = (
    observation: GatewayProviderObservation,
  ): GatewayProviderAuthority | null =>
    observation.kind === "present" && observation.resourceVersion === 1
      ? Object.freeze({ id: observation.id, resourceVersion: observation.resourceVersion })
      : null;
  const deleteRecordedProvider = (
    provider: string,
    journal: GatewayProviderJournal,
  ): GatewayProviderJournal => {
    const authority = journal.providerAuthority;
    if (journal.phase !== "rolling-back" || !authority) {
      throw new Error("Hermes Portable inference gateway provider rollback journal is incomplete.");
    }
    const current = readExact(provider);
    if (current.kind === "absent") {
      return journalStore.transition(journal, "rolled-back", authority);
    }
    if (!matchesAuthority(current, authority)) {
      throw new Error("Hermes Portable inference refused to mutate changed gateway authority.");
    }
    const removed = runGatewayOpenshell(["provider", "delete", provider], {
      ignoreError: true,
      suppressOutput: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GATEWAY_PROVIDER_MUTATION_TIMEOUT_MS,
    });
    const after = readExact(provider);
    if (after.kind === "absent") {
      return journalStore.transition(journal, "rolled-back", authority);
    }
    if (!matchesAuthority(after, authority)) {
      throw new Error(
        "Hermes Portable inference gateway authority changed during recorded rollback.",
      );
    }
    if (removed.status !== 0) {
      throw new Error("Hermes Portable inference could not resume its gateway provider rollback.");
    }
    throw new Error("Hermes Portable inference gateway provider remained after recorded rollback.");
  };
  const journalAtEntry = journalStore.load();
  const providerAtEntry = readExact("ollama-local");
  const recoverUnpublishedRoute =
    !receiptPublished &&
    journalAtEntry?.phase === "created" &&
    journalAtEntry.providerAuthority !== null &&
    matchesAuthority(providerAtEntry, journalAtEntry.providerAuthority);
  if (journalAtEntry === null || journalAtEntry.phase === "rolled-back") {
    if (providerAtEntry.kind !== "absent") {
      throw new Error("Hermes Portable inference found an unowned existing gateway provider.");
    }
  } else if (journalAtEntry.phase === "prepared") {
    if (providerAtEntry.kind !== "absent") {
      throw new Error(
        "Hermes Portable inference gateway provider appeared before recorded create.",
      );
    }
  } else if (journalAtEntry.phase === "creating") {
    if (providerAtEntry.kind === "present" && createdAuthority(providerAtEntry) === null) {
      throw new Error("Hermes Portable inference recorded provider creation is ambiguous.");
    }
  } else if (journalAtEntry.phase === "rolling-back") {
    if (
      providerAtEntry.kind === "present" &&
      (!journalAtEntry.providerAuthority ||
        !matchesAuthority(providerAtEntry, journalAtEntry.providerAuthority))
    ) {
      throw new Error("Hermes Portable inference recorded gateway provider authority changed.");
    }
  } else if (
    !journalAtEntry.providerAuthority ||
    !matchesAuthority(providerAtEntry, journalAtEntry.providerAuthority)
  ) {
    throw new Error("Hermes Portable inference recorded gateway provider authority changed.");
  }
  const prepareGatewayMutation: HostLocalInferenceStartupSelection["prepareGatewayMutation"] =
    async (input) => {
      if (
        input.gatewayName !== "nemoclaw" ||
        input.sandboxName !== expectedSandboxName ||
        input.provider !== "ollama-local" ||
        input.model !== expectedModel ||
        input.providerBaseUrl !== "http://host.openshell.internal:11434/v1"
      ) {
        throw new Error("Hermes Portable inference gateway mutation authority changed.");
      }
      let journal = journalStore.load();
      let current = readExact(input.provider);
      if (journal?.phase === "rolling-back") {
        journal = deleteRecordedProvider(input.provider, journal);
        current = readExact(input.provider);
      }
      if (receiptPublished) {
        if (journal?.phase !== "created" && journal?.phase !== "committed") {
          throw new Error(
            "Hermes Portable inference published route lacks gateway ownership state.",
          );
        }
      } else if (journal?.phase === "committed") {
        throw new Error(
          "Hermes Portable inference gateway ownership outlived its published receipt.",
        );
      }
      if (journal === null || journal.phase === "rolled-back") {
        if (current.kind !== "absent") {
          throw new Error("Hermes Portable inference found an unowned existing gateway provider.");
        }
        journalStore.prepare(journal);
      } else if (journal.phase === "prepared") {
        if (current.kind !== "absent") {
          throw new Error(
            "Hermes Portable inference gateway provider appeared before recorded create.",
          );
        }
      } else if (journal.phase === "creating") {
        if (current.kind === "present") {
          const authority = createdAuthority(current);
          if (!authority) {
            throw new Error("Hermes Portable inference recorded provider creation is ambiguous.");
          }
          journalStore.transition(journal, "created", authority);
        }
      } else {
        const authority = journal.providerAuthority;
        if (!authority || !matchesAuthority(current, authority)) {
          throw new Error("Hermes Portable inference recorded gateway provider authority changed.");
        }
      }
      return Object.freeze({
        upsertProvider(
          name: string,
          type: string,
          credentialEnv: string,
          baseUrl: string,
          env: NodeJS.ProcessEnv = {},
        ) {
          if (
            name !== input.provider ||
            type !== "openai" ||
            credentialEnv !== expectedCredentialEnv ||
            baseUrl !== input.providerBaseUrl ||
            Object.keys(env).length !== 1 ||
            env[expectedCredentialEnv] !== "ollama"
          ) {
            throw new Error("Hermes Portable inference provider mutation authority changed.");
          }
          let active = journalStore.load();
          if (!active) {
            throw new Error("Hermes Portable inference gateway provider intent disappeared.");
          }
          let before = readExact(input.provider);
          const requireOpenAiProfile = () => {
            const profile = checkOpenAiInferenceProviderProfile({
              runOpenshell: (args, options) =>
                runGatewayOpenshell(args, {
                  ignoreError: true,
                  suppressOutput: true,
                  stdio: ["ignore", "pipe", "pipe"],
                  timeout: options?.timeout ?? GATEWAY_PROVIDER_MUTATION_TIMEOUT_MS,
                }),
            });
            if (!profile.ok) {
              throw new Error(profile.messages.join("\n"));
            }
          };
          if (active.phase === "created" || active.phase === "committed") {
            if (!active.providerAuthority || !matchesAuthority(before, active.providerAuthority)) {
              throw new Error(
                "Hermes Portable inference recorded gateway provider authority changed.",
              );
            }
            requireOpenAiProfile();
            return { ok: true };
          }
          requireOpenAiProfile();
          if (active.phase === "prepared") {
            if (before.kind !== "absent") {
              throw new Error("Hermes Portable inference provider name is no longer unclaimed.");
            }
            active = journalStore.transition(active, "creating", null);
            before = readExact(input.provider);
          }
          if (active.phase !== "creating") {
            throw new Error("Hermes Portable inference gateway provider intent cannot create.");
          }
          if (before.kind === "present") {
            const authority = createdAuthority(before);
            if (!authority) {
              throw new Error("Hermes Portable inference recorded provider creation is ambiguous.");
            }
            journalStore.transition(active, "created", authority);
            return { ok: true };
          }
          const result = runGatewayOpenshell(
            [
              "provider",
              "create",
              "--name",
              input.provider,
              "--type",
              "openai",
              "--credential",
              expectedProviderCredentialEnv,
              "--config",
              `OPENAI_BASE_URL=${input.providerBaseUrl}`,
            ],
            {
              ignoreError: true,
              suppressOutput: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: { [expectedProviderCredentialEnv]: "ollama" },
              timeout: GATEWAY_PROVIDER_MUTATION_TIMEOUT_MS,
            },
          );
          const after = readExact(input.provider);
          const authority = createdAuthority(after);
          if (!authority) {
            if (after.kind === "absent" && result.status !== 0) {
              throw new Error("Hermes Portable inference could not create its gateway provider.");
            }
            throw new Error(
              "Hermes Portable inference gateway provider creation is indeterminate.",
            );
          }
          journalStore.transition(active, "created", authority);
          return { ok: true };
        },
        commit() {
          const current = readExact(input.provider);
          const active = journalStore.load();
          if (
            (active?.phase !== "created" && active?.phase !== "committed") ||
            !active.providerAuthority ||
            !matchesAuthority(current, active.providerAuthority)
          ) {
            throw new Error("Hermes Portable inference gateway provider authority changed.");
          }
        },
        rollback() {
          let active = journalStore.load();
          if (!active) {
            throw new Error(
              "Hermes Portable inference gateway provider rollback intent disappeared.",
            );
          }
          if (active.phase === "committed") {
            throw new Error("Hermes Portable inference refused rollback of a published provider.");
          }
          const observed = readExact(input.provider);
          if (active.phase === "rolled-back") {
            if (observed.kind !== "absent") {
              throw new Error("Hermes Portable inference rolled-back gateway provider reappeared.");
            }
            return;
          }
          if (active.phase === "prepared" || active.phase === "creating") {
            if (observed.kind === "absent") {
              journalStore.transition(active, "rolled-back", null);
              return;
            }
            const authority = active.phase === "creating" ? createdAuthority(observed) : null;
            if (!authority) {
              throw new Error(
                "Hermes Portable inference refused rollback of unowned gateway authority.",
              );
            }
            active = journalStore.transition(active, "created", authority);
          }
          if (active.phase === "created") {
            if (
              !active.providerAuthority ||
              !matchesAuthority(observed, active.providerAuthority)
            ) {
              throw new Error(
                "Hermes Portable inference refused to delete changed gateway authority.",
              );
            }
            active = journalStore.transition(active, "rolling-back", active.providerAuthority);
          }
          deleteRecordedProvider(input.provider, active);
        },
      });
    };
  return Object.freeze({ prepareGatewayMutation, recoverUnpublishedRoute });
}

export function createHermesPortableOllamaGatewayTransaction(options: {
  readonly directory: string;
  readonly transactionId: string;
  readonly targetSha256: string;
  readonly sandboxName: string;
  readonly model: string;
  readonly credentialEnv: string;
  readonly runGatewayOpenshell: HermesPortableOllamaGatewayRunner;
}) {
  const receiptProbe = createReceiptWriter(
    options.directory,
    options.transactionId,
    options.targetSha256,
    () => {},
  );
  const recoveredReceipt = receiptProbe.readPublished();
  if (
    recoveredReceipt !== null &&
    (recoveredReceipt.publication === undefined ||
      recoveredReceipt.publication.targetSha256 !== options.targetSha256)
  ) {
    throw new Error("Hermes Portable Ollama published transaction authority is inconsistent.");
  }
  const transactionId = recoveredReceipt?.publication?.transactionId ?? options.transactionId;
  const providerCredentialEnv = `${options.credentialEnv}_${transactionId.toUpperCase()}`;
  if (providerCredentialEnv.length > 128 || !SAFE_CREDENTIAL_ENV.test(providerCredentialEnv)) {
    throw new Error("Hermes Portable Ollama transaction credential authority is invalid.");
  }
  const gatewayProviderJournal = createGatewayProviderJournalStore(
    options.directory,
    Object.freeze({
      transactionId,
      targetSha256: options.targetSha256,
      gatewayName: "nemoclaw",
      sandboxName: options.sandboxName,
      provider: "ollama-local",
      model: options.model,
      type: "openai",
      credentialEnv: options.credentialEnv,
      providerCredentialEnv,
      baseUrl: "http://host.openshell.internal:11434/v1",
    }),
  );
  const receiptWriter = createReceiptWriter(
    options.directory,
    transactionId,
    options.targetSha256,
    gatewayProviderJournal.markCommitted,
  );
  const publishedReceipt = receiptWriter.readPublished();
  const gatewayJournalState = gatewayProviderJournal.load();
  if (
    (publishedReceipt !== null &&
      gatewayJournalState?.phase !== "created" &&
      gatewayJournalState?.phase !== "committed") ||
    (publishedReceipt === null && gatewayJournalState?.phase === "committed")
  ) {
    throw new Error("Hermes Portable Ollama gateway publication authority is inconsistent.");
  }
  const gatewayMutation = exactGatewayMutation(
    options.runGatewayOpenshell,
    options.model,
    options.sandboxName,
    options.credentialEnv,
    providerCredentialEnv,
    gatewayProviderJournal,
    publishedReceipt !== null,
  );
  return Object.freeze({
    receiptWriter,
    publishedReceipt,
    recoverUnpublishedRoute: gatewayMutation.recoverUnpublishedRoute,
    prepareGatewayMutation: gatewayMutation.prepareGatewayMutation,
  });
}

export interface HermesPortableOllamaPublishedInferenceAuthority {
  readonly receipt: ReturnType<typeof parseHostLocalInferenceReceipt>;
  readonly serializedReceipt: string;
  readonly receiptWriter: HostLocalInferenceReceiptWriter;
  readonly assertCurrent: () => void;
}

/** Re-prove an already committed Ollama publication without opening a mutation path. */
export function prepareHermesPortableOllamaPublishedInferenceAuthority(options: {
  readonly directory: string;
  readonly sandboxName: string;
  readonly credentialEnv: string;
  readonly runGatewayOpenshell: HermesPortableOllamaGatewayRunner;
}): HermesPortableOllamaPublishedInferenceAuthority {
  if (!SAFE_CREDENTIAL_ENV.test(options.credentialEnv)) {
    throw new Error("Hermes Portable Ollama credential authority is invalid.");
  }
  const receiptState = openPrivateStateFile(
    options.directory,
    "portable-inference.json",
    "receipt",
  );
  const serializedReceipt = receiptState.readExact();
  if (serializedReceipt === null) {
    throw new Error("Hermes Portable Ollama published receipt is missing.");
  }
  const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
  if (
    serializeHostLocalInferenceReceipt(receipt) !== serializedReceipt ||
    receipt.service !== "ollama" ||
    receipt.inference === undefined ||
    receipt.publication === undefined
  ) {
    throw new Error("Hermes Portable Ollama published receipt authority is inconsistent.");
  }
  const transactionId = receipt.publication.transactionId;
  const targetSha256 = receipt.publication.targetSha256;
  const providerCredentialEnv = `${options.credentialEnv}_${transactionId.toUpperCase()}`;
  if (providerCredentialEnv.length > 128 || !SAFE_CREDENTIAL_ENV.test(providerCredentialEnv)) {
    throw new Error("Hermes Portable Ollama transaction credential authority is invalid.");
  }
  const intent = Object.freeze({
    transactionId,
    targetSha256,
    gatewayName: "nemoclaw" as const,
    sandboxName: options.sandboxName,
    provider: "ollama-local" as const,
    model: receipt.inference.model,
    type: "openai" as const,
    credentialEnv: options.credentialEnv,
    providerCredentialEnv,
    baseUrl: "http://host.openshell.internal:11434/v1" as const,
  });
  const journalStore = createGatewayProviderJournalStore(
    options.directory,
    intent,
    "open-existing",
  );
  const journal = journalStore.load();
  if (journal?.phase !== "committed" || journal.providerAuthority === null) {
    throw new Error("Hermes Portable Ollama gateway publication is not committed.");
  }
  const provider = observeExactGatewayProvider(
    options.runGatewayOpenshell,
    "ollama-local",
    providerCredentialEnv,
  );
  if (
    provider.kind !== "present" ||
    provider.id !== journal.providerAuthority.id ||
    provider.resourceVersion !== journal.providerAuthority.resourceVersion
  ) {
    throw new Error("Hermes Portable Ollama gateway publication authority changed.");
  }
  const assertCurrent = (): void => {
    if (receiptState.readExact() !== serializedReceipt) {
      throw new Error("Hermes Portable Ollama published receipt authority changed.");
    }
    const currentJournal = journalStore.load();
    if (!isDeepStrictEqual(currentJournal, journal)) {
      throw new Error("Hermes Portable Ollama gateway publication journal changed.");
    }
    const currentProvider = observeExactGatewayProvider(
      options.runGatewayOpenshell,
      "ollama-local",
      providerCredentialEnv,
    );
    if (!isDeepStrictEqual(currentProvider, provider)) {
      throw new Error("Hermes Portable Ollama gateway provider authority changed.");
    }
  };
  const receiptWriter: HostLocalInferenceReceiptWriter = Object.freeze({
    transactionId,
    targetSha256,
    writeExact(value: string) {
      if (value !== serializedReceipt) {
        throw new Error("Hermes Portable Ollama recovery cannot publish different authority.");
      }
      assertCurrent();
      return serializedReceipt;
    },
  });
  return Object.freeze({ receipt, serializedReceipt, receiptWriter, assertCurrent });
}

export interface PreparedHermesPortableOllamaProviderRetirement {
  readonly authority: Readonly<{
    id: string;
    resourceVersion: number;
    journalSha256: string;
  }>;
  readonly present: boolean;
  readonly removeAndVerify: () => void;
  readonly verifyAbsent: () => void;
}

/** Bind and retire only the exact committed schema-7 gateway provider authority. */
export function prepareHermesPortableOllamaProviderRetirement(options: {
  readonly directory: string;
  readonly transactionId: string;
  readonly targetSha256: string;
  readonly sandboxName: string;
  readonly model: string;
  readonly credentialEnv: string;
  readonly runGatewayOpenshell: HermesPortableOllamaGatewayRunner;
  readonly allowAbsent?: boolean;
}): PreparedHermesPortableOllamaProviderRetirement {
  const providerCredentialEnv = `${options.credentialEnv}_${options.transactionId.toUpperCase()}`;
  if (providerCredentialEnv.length > 128 || !SAFE_CREDENTIAL_ENV.test(providerCredentialEnv)) {
    throw new Error("Hermes Portable Ollama transaction credential authority is invalid.");
  }
  const store = createGatewayProviderJournalStore(
    options.directory,
    Object.freeze({
      transactionId: options.transactionId,
      targetSha256: options.targetSha256,
      gatewayName: "nemoclaw",
      sandboxName: options.sandboxName,
      provider: "ollama-local",
      model: options.model,
      type: "openai",
      credentialEnv: options.credentialEnv,
      providerCredentialEnv,
      baseUrl: "http://host.openshell.internal:11434/v1",
    }),
    "open-existing",
  );
  const journal = store.load();
  if (journal?.phase !== "committed" || !journal.providerAuthority) {
    throw new Error("Hermes Portable uninstall requires committed gateway provider authority.");
  }
  const expectedJournal = `${JSON.stringify(journal)}\n`;
  const expected = journal.providerAuthority;
  const observe = () =>
    observeExactGatewayProvider(options.runGatewayOpenshell, "ollama-local", providerCredentialEnv);
  const matches = (
    observation: GatewayProviderObservation,
  ): observation is Extract<GatewayProviderObservation, { kind: "present" }> =>
    observation.kind === "present" &&
    observation.id === expected.id &&
    observation.resourceVersion === expected.resourceVersion;
  const requireJournal = (): void => {
    const current = store.load();
    if (!current || `${JSON.stringify(current)}\n` !== expectedJournal) {
      throw new Error("Hermes Portable gateway provider journal authority changed.");
    }
  };
  const initial = observe();
  if (initial.kind === "present" && !matches(initial)) {
    throw new Error("Hermes Portable gateway provider authority changed before uninstall.");
  }
  if (initial.kind === "absent" && !options.allowAbsent) {
    throw new Error("Hermes Portable gateway provider disappeared before uninstall journaled it.");
  }
  const verifyAbsent = (): void => {
    requireJournal();
    const current = observe();
    if (current.kind === "present") {
      throw new Error(
        matches(current)
          ? "Hermes Portable gateway provider remained after uninstall."
          : "Hermes Portable gateway provider was replaced during uninstall.",
      );
    }
  };
  return Object.freeze({
    authority: Object.freeze({
      id: expected.id,
      resourceVersion: expected.resourceVersion,
      journalSha256: createHash("sha256").update(expectedJournal, "utf8").digest("hex"),
    }),
    present: initial.kind === "present",
    removeAndVerify() {
      requireJournal();
      const current = observe();
      if (current.kind === "absent") return;
      if (!matches(current)) {
        throw new Error("Hermes Portable refused to remove changed gateway provider authority.");
      }
      const removed = options.runGatewayOpenshell(["provider", "delete", "ollama-local"], {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GATEWAY_PROVIDER_MUTATION_TIMEOUT_MS,
      });
      const after = observe();
      if (after.kind === "absent") {
        requireJournal();
        return;
      }
      if (!matches(after)) {
        throw new Error("Hermes Portable gateway provider changed during uninstall.");
      }
      if (removed.status !== 0) {
        throw new Error("Hermes Portable could not remove its exact gateway provider.");
      }
      throw new Error("Hermes Portable gateway provider remained after uninstall.");
    },
    verifyAbsent,
  });
}

export function hasHermesPortableOllamaRecoveryContainer(
  engine: ReturnType<typeof createHermesPortablePodmanOperationEngines>["hostLocalInference"],
  containerName: string,
  assertCurrent: () => void,
): boolean {
  assertCurrent();
  const result = engine.capture(
    [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `name=^${containerName}$`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ],
    30_000,
  );
  assertCurrent();
  if (result.error || result.status !== 0) {
    throw new Error("Hermes Portable inference could not inspect interrupted runtime authority.");
  }
  const rows = result.stdout
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0) return false;
  const fields = rows.length === 1 ? rows[0]!.split("\t") : [];
  if (fields.length !== 2 || !NETWORK_ID.test(fields[0]!) || fields[1] !== containerName) {
    throw new Error("Hermes Portable inference found ambiguous interrupted runtime authority.");
  }
  return true;
}
