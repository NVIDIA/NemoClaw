// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { openRegularFileNoFollow } from "../fs/regular-file";
import {
  DEFAULT_GATEWAY_PORT,
  managedGatewayStateRootOwnershipFailure,
  resolveGatewayStateDirForPort,
} from "../../onboard/gateway/state-dir";
import { isValidName } from "../../sandbox-name-contract";
import type {
  OpenShellSandboxCommandCompletion,
  OpenShellSandboxCommandOutcome,
  OpenShellSandboxCommandRequest,
} from "./sandbox-command";
import type { OpenShellGatewayTarget } from "./sandbox-observer";

const MAX_PEM_BYTES = 1024 * 1024;

class OpenShellSdkPreflightUnavailableError extends Error {}

type SdkExecEvent =
  | Readonly<{ stream: "stdout" | "stderr"; data: Buffer }>
  | Readonly<{ type: "exit"; exitCode: number }>;

type SdkSandboxClient = Readonly<{
  execStream(
    name: string,
    command: string[],
    options?: Readonly<{
      noLoginShell?: boolean;
      signal?: AbortSignal;
      timeoutSecs?: number;
      workdir?: string;
    }>,
  ): AsyncIterable<SdkExecEvent>;
}>;

type SdkClient = Readonly<{ sandbox: SdkSandboxClient }>;

type OpenShellSdkModule = Readonly<{
  OpenShellClient: Readonly<{
    connect(
      options: Readonly<{
        caCert: Buffer;
        clientCert: Buffer;
        clientKey: Buffer;
        gateway: string;
      }>,
    ): Promise<SdkClient>;
  }>;
}>;

export type SdkOpenShellSandboxCommandExecutorDeps = Readonly<{
  connect?: (target: OpenShellGatewayTarget) => Promise<SdkClient>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  loadSdk?: () => Promise<OpenShellSdkModule>;
  stderr?: (data: Buffer) => void;
  stdout?: (data: Buffer) => void;
}>;

function readPem(target: string): Buffer {
  const file = openRegularFileNoFollow(target);
  try {
    return file.readBytes(MAX_PEM_BYTES);
  } finally {
    file.close();
  }
}

function gatewayPort(target: OpenShellGatewayTarget): number {
  if (target.kind !== "named") {
    throw new Error("OpenShell SDK execution requires an explicit gateway target");
  }
  if (target.gatewayName === "nemoclaw") return DEFAULT_GATEWAY_PORT;
  const match = target.gatewayName.match(/^nemoclaw-([1-9][0-9]{0,4})$/u);
  const port = Number(match?.[1] ?? 0);
  if (
    !match ||
    port === DEFAULT_GATEWAY_PORT ||
    port > 65_535 ||
    `nemoclaw-${String(port)}` !== target.gatewayName
  ) {
    throw new Error(`Invalid OpenShell gateway '${target.gatewayName}'`);
  }
  return port;
}

async function loadOpenShellSdk(): Promise<OpenShellSdkModule> {
  // Keep the optional reviewed package load lazy so source-only development can
  // still compile before CI stages the private SDK artifact.
  const packageName = "@nvidia/openshell-sdk";
  return (await import(packageName)) as OpenShellSdkModule;
}

/** Connect the SDK directly to one managed gateway, independent of compute provider. */
export async function connectManagedOpenShellSdk(
  target: OpenShellGatewayTarget,
  deps: Pick<SdkOpenShellSandboxCommandExecutorDeps, "env" | "homeDir" | "loadSdk"> = {},
): Promise<SdkClient> {
  const port = gatewayPort(target);
  const environment = deps.env ?? process.env;
  const configuredStateDir = environment.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
  const stateDir = resolveGatewayStateDirForPort({
    configured: configuredStateDir,
    home: deps.homeDir ?? environment.HOME ?? os.homedir(),
    port,
  });
  const gatewayName = target.kind === "named" ? target.gatewayName : "";
  const ownershipFailure = managedGatewayStateRootOwnershipFailure({
    gatewayName,
    gatewayPort: port,
    stateDir,
  });
  if (ownershipFailure) {
    const message = `Unsafe OpenShell gateway state directory: ${ownershipFailure}.`;
    if (configuredStateDir) throw new Error(message);
    throw new OpenShellSdkPreflightUnavailableError(message);
  }
  const tlsDirectory = path.join(stateDir, "tls");
  const sdk = await (deps.loadSdk ?? loadOpenShellSdk)();
  return sdk.OpenShellClient.connect({
    gateway: `https://127.0.0.1:${String(port)}`,
    caCert: readPem(path.join(tlsDirectory, "ca.crt")),
    clientCert: readPem(path.join(tlsDirectory, "client", "tls.crt")),
    clientKey: readPem(path.join(tlsDirectory, "client", "tls.key")),
  });
}

function commandFailure(error: unknown): OpenShellSandboxCommandOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return {
    kind: "failed",
    error: {
      kind:
        error instanceof OpenShellSdkPreflightUnavailableError ||
        /Cannot find (?:module|package) ['"]@nvidia\/openshell-sdk['"]/u.test(message)
          ? "unavailable"
          : /timeout|deadline/iu.test(`${code} ${message}`)
            ? "timeout"
            : "invocation",
      message,
    },
  };
}

function assertRequestName(name: string, label: string): void {
  if (!isValidName(name)) throw new Error(`Invalid OpenShell ${label} name`);
}

/** SDK-backed streaming executor used by non-interactive sandbox actions. */
export function createSdkOpenShellSandboxCommandExecutor(
  deps: SdkOpenShellSandboxCommandExecutorDeps = {},
): Readonly<{
  runStreaming(request: OpenShellSandboxCommandRequest): Promise<OpenShellSandboxCommandCompletion>;
}> {
  const connect = deps.connect ?? ((target) => connectManagedOpenShellSdk(target, deps));
  const stdout = deps.stdout ?? ((data: Buffer) => process.stdout.write(data));
  const stderr = deps.stderr ?? ((data: Buffer) => process.stderr.write(data));

  return {
    runStreaming: async (request): Promise<OpenShellSandboxCommandCompletion> => {
      assertRequestName(request.sandboxName, "sandbox");
      gatewayPort(request.target);
      if (request.tty === true || request.stdin === true) {
        return {
          outcome: {
            kind: "failed",
            error: {
              kind: "invocation",
              message:
                "OpenShell SDK non-interactive execution does not accept TTY or inherited stdin",
            },
          },
          release: () => {},
        };
      }

      try {
        const client = await connect(request.target);
        let exitCode: number | undefined;
        for await (const event of client.sandbox.execStream(
          request.sandboxName,
          [...request.command],
          {
            noLoginShell: true,
            ...(request.timeoutSeconds !== undefined
              ? { timeoutSecs: request.timeoutSeconds }
              : {}),
            ...(request.workdir ? { workdir: request.workdir } : {}),
          },
        )) {
          if ("type" in event) exitCode = event.exitCode;
          else if (event.stream === "stdout") stdout(event.data);
          else stderr(event.data);
        }
        if (exitCode === undefined) {
          throw new Error("OpenShell SDK exec stream ended without an exit event");
        }
        return { outcome: { kind: "completed", exitCode }, release: () => {} };
      } catch (error) {
        return { outcome: commandFailure(error), release: () => {} };
      }
    },
  };
}
