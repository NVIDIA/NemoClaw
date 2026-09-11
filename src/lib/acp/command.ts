// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { withConnectSandboxLifecycleLock } from "../actions/sandbox/lifecycle/lock";
import { createCliHermesAcpSshTransport } from "../adapters/openshell/hermes-acp-ssh-cli";
import type { HermesAcpSshTransport } from "../adapters/openshell/hermes-acp-ssh";
import { inspectOpenShellSandboxIdentityFingerprint } from "../adapters/openshell/sandbox-identity-cli";
import {
  createCliOpenShellSandboxObserver,
  type CaptureSandboxCommand,
} from "../adapters/openshell/sandbox-observer-cli";
import type { OpenShellSandboxObserver } from "../adapters/openshell/sandbox-observer";
import { captureSanitizedResolvedOpenshell } from "../adapters/openshell/sanitized-capture";
import { OPENSHELL_DEFAULT_WORKSPACE } from "../adapters/openshell/sandbox-ssh-host";
import { getVersion } from "../core/version";
import { HERMES_LIFECYCLE_DEFINITION } from "../domain/lifecycle/hermes-definition";
import { recoverNamedGatewayRuntime } from "../gateway-runtime-action";
import { assertNoOpenShellGatewayEndpointOverride } from "../openshell-gateway-endpoint-guard";
import { resolveGatewayName, resolveGatewayPortFromName } from "../onboard/gateway-binding";
import type { GatewayRecoveryOutput } from "../onboard/gateway-recovery";
import { sanitizeReadinessText } from "../readiness/sanitize";
import { isValidName } from "../sandbox-name-contract";
import {
  listHostGatewayRegistryEntries,
  type HostGatewayRegistryEntry,
} from "../state/gateway-registry";

const HELP = `Usage: nemoclaw-acp --sandbox <name> [--gateway <name>] [--timeout <seconds>]

Connect an external ACP client to the managed Hermes ACP server in a NemoClaw sandbox.

Options:
  --sandbox <name>    Managed Hermes sandbox (required)
  --gateway <name>    Owning OpenShell gateway (required when the name is ambiguous)
  --timeout <seconds> End the ACP session after this many seconds
  --help              Show help
  --version           Show the NemoClaw version
`;

const MAX_TIMEOUT_SECONDS = 86_400;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_GATEWAY_RECOVERY_DIAGNOSTICS = 64;
const MAX_GATEWAY_RECOVERY_DIAGNOSTIC_LENGTH = 240;

type CommandIo = Readonly<{
  input: Readable;
  output: Writable;
  diagnostics: Writable;
}>;

type CommandOptions = Readonly<{
  gatewayName?: string;
  mode: "help" | "run" | "version";
  sandboxName?: string;
  timeoutMs?: number;
}>;

export type HermesAcpTarget = Readonly<{
  entry: HostGatewayRegistryEntry["entry"];
  gatewayName: string;
  gatewayPort: number;
  sandboxName: string;
  stateRoot: string;
}>;

export type HermesAcpTargetResolution =
  | Readonly<{ ok: true; target: HermesAcpTarget }>
  | Readonly<{
      ok: false;
      error: "ambiguous" | "incompatible" | "missing";
      message: string;
    }>;

type RecoveryResult = Awaited<ReturnType<typeof recoverNamedGatewayRuntime>>;

export type HermesAcpCommandDeps = Readonly<{
  currentVersion?: () => string;
  home?: () => string;
  inspectIdentity?: typeof inspectOpenShellSandboxIdentityFingerprint;
  listRegistry?: typeof listHostGatewayRegistryEntries;
  observer?: OpenShellSandboxObserver;
  recoverGateway?: (options: {
    gatewayName: string;
    output: GatewayRecoveryOutput;
    runtimeSelection: { gatewayName: string; workspace: string };
  }) => Promise<RecoveryResult>;
  transport?: HermesAcpSshTransport;
  withLifecycleLock?: typeof withConnectSandboxLifecycleLock;
}>;

function usageError(message: string): never {
  throw Object.assign(new Error(message), { code: "USAGE" });
}

function nextValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) usageError(`${option} requires a value.`);
  return value;
}

export function parseHermesAcpCommandArgs(argv: readonly string[]): CommandOptions {
  let gatewayName: string | undefined;
  let sandboxName: string | undefined;
  let timeoutMs: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { mode: "help" };
    if (arg === "--version" || arg === "-v") return { mode: "version" };
    if (arg === "--sandbox") {
      if (sandboxName !== undefined) usageError("--sandbox may be provided only once.");
      sandboxName = nextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--gateway") {
      if (gatewayName !== undefined) usageError("--gateway may be provided only once.");
      gatewayName = nextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      if (timeoutMs !== undefined) usageError("--timeout may be provided only once.");
      const value = nextValue(argv, index, arg);
      if (!/^[1-9][0-9]*$/u.test(value)) usageError("--timeout must be a positive integer.");
      const seconds = Number(value);
      if (!Number.isSafeInteger(seconds) || seconds > MAX_TIMEOUT_SECONDS) {
        usageError(`--timeout must not exceed ${String(MAX_TIMEOUT_SECONDS)} seconds.`);
      }
      timeoutMs = seconds * 1_000;
      index += 1;
      continue;
    }
    usageError(`Unknown option: ${arg ?? ""}`);
  }
  if (!sandboxName) usageError("--sandbox is required.");
  if (!isValidName(sandboxName)) usageError("--sandbox has an invalid name.");
  if (gatewayName !== undefined) {
    const gatewayPort = isValidName(gatewayName) ? resolveGatewayPortFromName(gatewayName) : null;
    if (gatewayPort === null || resolveGatewayName(gatewayPort) !== gatewayName) {
      usageError("--gateway has an invalid NemoClaw gateway name.");
    }
  }
  return {
    mode: "run",
    sandboxName,
    ...(gatewayName ? { gatewayName } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function compatibleEntry(entry: HostGatewayRegistryEntry["entry"], version: string): boolean {
  return (
    entry.agent === HERMES_LIFECYCLE_DEFINITION.agent &&
    entry.agentVersion === HERMES_LIFECYCLE_DEFINITION.agentVersion &&
    entry.openshellVersion === HERMES_LIFECYCLE_DEFINITION.openshellVersion &&
    entry.nemoclawVersion === version &&
    (entry.fromDockerfile === undefined || entry.fromDockerfile === null) &&
    typeof entry.lifecycleGeneration === "string" &&
    entry.lifecycleGeneration.length > 0 &&
    entry.lifecycleGeneration.length <= 128 &&
    typeof entry.lifecycleLiveIdentityFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(entry.lifecycleLiveIdentityFingerprint)
  );
}

export function resolveHermesAcpTarget(
  entries: readonly HostGatewayRegistryEntry[],
  request: Readonly<{ gatewayName?: string; sandboxName: string; nemoclawVersion: string }>,
): HermesAcpTargetResolution {
  const requestedPort = request.gatewayName
    ? resolveGatewayPortFromName(request.gatewayName)
    : null;
  const matches = entries.filter(
    ({ entry, gatewayPort }) =>
      entry.name === request.sandboxName &&
      entry.pendingRouteReservation !== true &&
      (request.gatewayName === undefined || requestedPort === gatewayPort),
  );
  if (matches.length === 0) {
    return {
      ok: false,
      error: "missing",
      message: "The requested sandbox is not registered on the selected gateway.",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "ambiguous",
      message: "The sandbox name is registered on more than one gateway; provide --gateway.",
    };
  }
  const match = matches[0]!;
  const gatewayName = resolveGatewayName(match.gatewayPort);
  if (
    match.entry.gatewayName !== gatewayName ||
    !compatibleEntry(match.entry, request.nemoclawVersion)
  ) {
    return {
      ok: false,
      error: "incompatible",
      message: "The requested sandbox is not a compatible managed Hermes sandbox.",
    };
  }
  return {
    ok: true,
    target: {
      entry: match.entry,
      gatewayName,
      gatewayPort: match.gatewayPort,
      sandboxName: request.sandboxName,
      stateRoot: match.stateRoot,
    },
  };
}

async function writeLine(stream: Writable, message: string): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      if (stream.write(`${message}\n`)) resolve();
      else stream.once("drain", resolve);
    } catch {
      resolve();
    }
  });
}

function defaultObserver(): OpenShellSandboxObserver {
  return createCliOpenShellSandboxObserver({
    capture: captureSanitizedResolvedOpenshell as CaptureSandboxCommand,
  });
}

function gatewayRecoveryDiagnostic(message: string): string {
  return sanitizeReadinessText(message, MAX_GATEWAY_RECOVERY_DIAGNOSTIC_LENGTH)
    .replace(/\s+/gu, " ")
    .trim();
}

function createGatewayRecoveryDiagnostics(): {
  flush(stream: Writable): Promise<void>;
  output: GatewayRecoveryOutput;
} {
  const lines: string[] = [];
  const append = (message: string) => {
    if (lines.length >= MAX_GATEWAY_RECOVERY_DIAGNOSTICS) return;
    const diagnostic = gatewayRecoveryDiagnostic(message);
    if (diagnostic) lines.push(diagnostic);
  };
  return {
    output: {
      error: append,
      log: append,
      step: (current, total, label) => append(`[${String(current)}/${String(total)}] ${label}`),
      warn: append,
    },
    async flush(stream) {
      for (const line of lines) await writeLine(stream, line);
    },
  };
}

async function validateLiveTarget(
  target: HermesAcpTarget,
  observer: OpenShellSandboxObserver,
  inspectIdentity: typeof inspectOpenShellSandboxIdentityFingerprint,
): Promise<string | null> {
  const inventory = await observer.listSandboxes({
    target: { kind: "named", gatewayName: target.gatewayName },
  });
  if (!inventory.ok) return "OpenShell could not inspect the selected sandbox.";
  const matches = inventory.value.sandboxes.filter(({ name }) => name === target.sandboxName);
  if (matches.length === 0) return "The requested sandbox is missing.";
  if (matches.length > 1) return "OpenShell returned an ambiguous sandbox identity.";
  if (matches[0]!.readiness !== "ready") return "The requested sandbox is stopped or not ready.";
  const fingerprint = inspectIdentity({
    gatewayName: target.gatewayName,
    sandboxName: target.sandboxName,
  });
  return fingerprint === target.entry.lifecycleLiveIdentityFingerprint
    ? null
    : "The live sandbox identity does not match its NemoClaw registration.";
}

/** Run the packaged host-side ACP adapter without writing ACP-adjacent progress to stdout. */
export async function runHermesAcpCommand(
  argv: readonly string[],
  io: CommandIo,
  deps: HermesAcpCommandDeps = {},
): Promise<number> {
  let options: CommandOptions;
  try {
    options = parseHermesAcpCommandArgs(argv);
  } catch (error) {
    await writeLine(io.diagnostics, error instanceof Error ? error.message : "Invalid arguments.");
    return 2;
  }
  if (options.mode === "help") {
    await writeLine(io.output, HELP.trimEnd());
    return 0;
  }
  if (options.mode === "version") {
    await writeLine(io.output, (deps.currentVersion ?? getVersion)());
    return 0;
  }

  const home = (deps.home ?? os.homedir)();
  let entries: HostGatewayRegistryEntry[];
  try {
    entries = (deps.listRegistry ?? listHostGatewayRegistryEntries)(home);
  } catch {
    await writeLine(io.diagnostics, "NemoClaw could not safely inspect the sandbox registry.");
    return 1;
  }
  const currentVersion = (deps.currentVersion ?? getVersion)();
  const resolved = resolveHermesAcpTarget(entries, {
    gatewayName: options.gatewayName,
    sandboxName: options.sandboxName!,
    nemoclawVersion: currentVersion,
  });
  if (!resolved.ok) {
    await writeLine(io.diagnostics, resolved.message);
    return 1;
  }

  const selectedTarget = resolved.target;
  try {
    assertNoOpenShellGatewayEndpointOverride();
  } catch {
    await writeLine(
      io.diagnostics,
      "OPENSHELL_GATEWAY_ENDPOINT must be unset before starting the ACP adapter.",
    );
    return 1;
  }
  let completion: ReturnType<HermesAcpSshTransport["run"]>;
  try {
    const started = await (deps.withLifecycleLock ?? withConnectSandboxLifecycleLock)(
      selectedTarget.sandboxName,
      async () => {
        let currentEntries: HostGatewayRegistryEntry[];
        try {
          currentEntries = (deps.listRegistry ?? listHostGatewayRegistryEntries)(home);
        } catch {
          return {
            error: "NemoClaw could not safely revalidate the sandbox registry.",
          } as const;
        }
        const current = resolveHermesAcpTarget(currentEntries, {
          gatewayName: selectedTarget.gatewayName,
          sandboxName: selectedTarget.sandboxName,
          nemoclawVersion: currentVersion,
        });
        if (
          !current.ok ||
          current.target.stateRoot !== selectedTarget.stateRoot ||
          current.target.entry.lifecycleGeneration !== selectedTarget.entry.lifecycleGeneration ||
          current.target.entry.lifecycleLiveIdentityFingerprint !==
            selectedTarget.entry.lifecycleLiveIdentityFingerprint
        ) {
          return {
            error: "The requested sandbox changed before the ACP adapter could start.",
          } as const;
        }
        const target = current.target;
        const runtimeSelection = {
          gatewayName: target.gatewayName,
          workspace: OPENSHELL_DEFAULT_WORKSPACE,
        };
        const recoveryDiagnostics = createGatewayRecoveryDiagnostics();
        let recovery: RecoveryResult;
        try {
          recovery = await (deps.recoverGateway ?? recoverNamedGatewayRuntime)({
            gatewayName: target.gatewayName,
            output: recoveryDiagnostics.output,
            runtimeSelection,
          });
        } catch {
          await recoveryDiagnostics.flush(io.diagnostics);
          return { error: "The selected OpenShell gateway could not be recovered." } as const;
        }
        await recoveryDiagnostics.flush(io.diagnostics);
        if (!recovery.recovered || recovery.after.state !== "healthy_named") {
          return { error: "The selected OpenShell gateway is not ready." } as const;
        }

        let liveError: string | null;
        try {
          liveError = await validateLiveTarget(
            target,
            deps.observer ?? defaultObserver(),
            deps.inspectIdentity ?? inspectOpenShellSandboxIdentityFingerprint,
          );
        } catch {
          liveError = "OpenShell could not validate the selected sandbox identity.";
        }
        if (liveError) return { error: liveError } as const;

        let markSessionStarted!: () => void;
        const sessionStarted = new Promise<void>((resolve) => {
          markSessionStarted = resolve;
        });
        const transportCompletion = (deps.transport ?? createCliHermesAcpSshTransport()).run({
          gatewayName: target.gatewayName,
          sandboxName: target.sandboxName,
          streams: io,
          onSessionStarted: markSessionStarted,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        });
        await Promise.race([
          sessionStarted,
          transportCompletion.then(
            () => undefined,
            () => undefined,
          ),
        ]);
        return { completion: transportCompletion, error: null } as const;
      },
      { stateDir: path.join(selectedTarget.stateRoot, "state") },
    );
    if (started.error !== null) {
      await writeLine(io.diagnostics, started.error);
      return 1;
    }
    completion = started.completion;
  } catch {
    await writeLine(io.diagnostics, "The Hermes ACP transport could not start safely.");
    return 1;
  }
  let outcome;
  try {
    outcome = await completion;
  } catch {
    await writeLine(io.diagnostics, "The Hermes ACP transport could not start safely.");
    return 1;
  }
  if (outcome.kind === "failed" && outcome.error.kind !== "client_disconnect") {
    await writeLine(io.diagnostics, outcome.error.message);
  }
  return outcome.exitCode;
}
