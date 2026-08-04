// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  applyManagedStartupRootRequest,
  atomicWriteRootFile,
  MANAGED_STARTUP_COMPLETION_FILE,
  MANAGED_STARTUP_RUNTIME_ENV_FILE,
  ManagedStartupImageRuntimeError,
  type ManagedStartupRootApplyResult,
  main as mainManagedStartupImageRuntime,
  readStableRegularFileSnapshot,
  verifyManagedStartupImageCompletion,
} from "../managed-startup/image-runtime";
import { MANAGED_STARTUP_AGENTS, type ManagedStartupAgent } from "../managed-startup/profile";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  MANAGED_BOOTSTRAP_COMPLETION_FILE,
  MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES,
  MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES,
  MANAGED_BOOTSTRAP_REQUEST_FILE,
  type ManagedBootstrapImageCompletion,
  parseManagedBootstrapEnvelope,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";

const SHA256_RE = /^[a-f0-9]{64}$/u;
type Environment = Record<string, string | undefined>;

export interface ManagedBootstrapImageRuntimeExpected {
  readonly agent: ManagedStartupAgent;
  readonly profileFingerprint: string;
  readonly bootstrapIdentity: string;
}

interface ManagedBootstrapEnvelopeSnapshot {
  readonly request: ManagedStartupRootApplyRequest;
  readonly stat: fs.BigIntStats;
}

function fail(message: string): never {
  throw new ManagedStartupImageRuntimeError(message);
}

function requireRoot(): void {
  if (process.geteuid?.() !== 0) {
    fail("managed bootstrap image runtime requires container effective uid 0");
  }
}

function exactAgent(value: string): ManagedStartupAgent {
  if (!MANAGED_STARTUP_AGENTS.includes(value as ManagedStartupAgent)) {
    fail(`unsupported agent ${JSON.stringify(value)}`);
  }
  return value as ManagedStartupAgent;
}

function readExpected(argv: readonly string[]): ManagedBootstrapImageRuntimeExpected {
  if (argv.length !== 7) {
    fail(
      "usage: managed-startup-image-runtime [--apply-bootstrap-file|--verify-bootstrap-completion] --agent <agent> --profile-fingerprint <sha256> --bootstrap-identity <sha256>",
    );
  }
  const valueAfter = (flag: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0 || index + 1 >= argv.length)
      fail(`managed bootstrap ${flag} argument is missing`);
    return argv[index + 1] as string;
  };
  const profileFingerprint = valueAfter("--profile-fingerprint");
  const bootstrapIdentity = valueAfter("--bootstrap-identity");
  if (!SHA256_RE.test(profileFingerprint) || !SHA256_RE.test(bootstrapIdentity)) {
    fail("managed bootstrap image runtime identities must encode 32 lowercase-hex bytes");
  }
  return {
    agent: exactAgent(valueAfter("--agent")),
    profileFingerprint,
    bootstrapIdentity,
  };
}

function readManagedBootstrapEnvelopeSnapshot(
  expected: ManagedBootstrapImageRuntimeExpected,
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
): ManagedBootstrapEnvelopeSnapshot {
  requireRoot();
  const { bytes, stat } = readStableRegularFileSnapshot(
    requestFile,
    MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES,
  );
  if (
    stat.nlink !== 1n ||
    stat.uid !== 0n ||
    stat.gid !== 0n ||
    Number(stat.mode & 0o777n) !== 0o400
  ) {
    fail("managed bootstrap envelope must be root:root mode 0400 with one link");
  }
  const envelope = parseManagedBootstrapEnvelope(bytes.toString("utf8"));
  if (
    envelope.bootstrapIdentity !== expected.bootstrapIdentity ||
    envelope.rootApplyRequest.agent !== expected.agent ||
    envelope.rootApplyRequest.profileFingerprint !== expected.profileFingerprint
  ) {
    fail("managed bootstrap envelope identity does not match the replacement");
  }
  return { request: envelope.rootApplyRequest, stat };
}

export function readManagedBootstrapEnvelope(
  expected: ManagedBootstrapImageRuntimeExpected,
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
): ManagedStartupRootApplyRequest {
  return readManagedBootstrapEnvelopeSnapshot(expected, requestFile).request;
}

function requireManagedBootstrapEnvelopeIdentity(
  requestFile: string,
  expected: fs.BigIntStats,
): void {
  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(requestFile, { bigint: true });
  } catch {
    fail("managed bootstrap envelope changed before cleanup");
  }
  if (
    !current.isFile() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mode !== expected.mode ||
    current.nlink !== 1n ||
    current.uid !== 0n ||
    current.gid !== 0n ||
    current.size !== expected.size ||
    current.mtimeNs !== expected.mtimeNs ||
    current.ctimeNs !== expected.ctimeNs
  ) {
    fail("managed bootstrap envelope changed before cleanup");
  }
}

export async function applyManagedBootstrapEnvelope(
  expected: ManagedBootstrapImageRuntimeExpected,
  env: Environment = process.env,
  requestFile: string = MANAGED_BOOTSTRAP_REQUEST_FILE,
  completionFile: string = MANAGED_BOOTSTRAP_COMPLETION_FILE,
): Promise<ManagedStartupRootApplyResult> {
  const envelope = readManagedBootstrapEnvelopeSnapshot(expected, requestFile);
  const result = await applyManagedStartupRootRequest(envelope.request, env, {
    bootstrapIdentity: expected.bootstrapIdentity,
  });
  requireManagedBootstrapEnvelopeIdentity(requestFile, envelope.stat);
  atomicWriteRootFile(
    completionFile,
    serializeManagedBootstrapImageCompletion({
      agent: result.agent,
      bootstrapIdentity: expected.bootstrapIdentity,
      profileFingerprint: result.fingerprint,
      transactionPending: result.transactionPending,
    }),
    0o444,
  );
  requireManagedBootstrapEnvelopeIdentity(requestFile, envelope.stat);
  fs.unlinkSync(requestFile);
  return result;
}

export function verifyManagedBootstrapImageCompletion(
  expected: ManagedBootstrapImageRuntimeExpected,
  completionFile: string = MANAGED_BOOTSTRAP_COMPLETION_FILE,
  startupCompletionFile: string = MANAGED_STARTUP_COMPLETION_FILE,
  runtimeEnvironmentFile: string = MANAGED_STARTUP_RUNTIME_ENV_FILE,
): ManagedBootstrapImageCompletion {
  requireRoot();
  const { bytes, stat } = readStableRegularFileSnapshot(
    completionFile,
    MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES,
  );
  if (
    stat.nlink !== 1n ||
    stat.uid !== 0n ||
    stat.gid !== 0n ||
    Number(stat.mode & 0o777n) !== 0o444
  ) {
    fail("managed bootstrap completion must be root:root mode 0444 with one link");
  }
  const completion = parseManagedBootstrapImageCompletion(bytes.toString("utf8"));
  if (
    completion.agent !== expected.agent ||
    completion.profileFingerprint !== expected.profileFingerprint ||
    completion.bootstrapIdentity !== expected.bootstrapIdentity
  ) {
    fail("managed bootstrap completion identity does not match the replacement");
  }
  verifyManagedStartupImageCompletion(
    expected.agent,
    expected.profileFingerprint,
    startupCompletionFile,
    runtimeEnvironmentFile,
  );
  return completion;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "--apply-bootstrap-file") {
    const expected = readExpected(argv);
    const result = await applyManagedBootstrapEnvelope(expected);
    console.log(
      result.transactionPending
        ? `[managed-startup] applied ${result.agent} profile ${result.fingerprint}; transaction pending`
        : `[managed-startup] ${result.agent} profile ${result.fingerprint} was already complete`,
    );
    return;
  }
  if (argv[0] === "--verify-bootstrap-completion") {
    const expected = readExpected(argv);
    const completion = verifyManagedBootstrapImageCompletion(expected);
    console.log(
      `[managed-startup] verified ${expected.agent} profile ${expected.profileFingerprint} bootstrap ${expected.bootstrapIdentity}${
        completion.transactionPending ? "; transaction pending" : ""
      }`,
    );
    return;
  }
  await mainManagedStartupImageRuntime(argv);
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
