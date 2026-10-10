// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";
import { openRegularFileNoFollow } from "../fs/regular-file";
import {
  DEFAULT_GATEWAY_PORT,
  externallySupervisedGatewayStateRootOwnershipFailure,
  managedGatewayStateRootOwnershipFailure,
  resolveDefaultGatewayStateDirForPort,
  resolveGatewayStateDirForPort,
} from "../../onboard/gateway/state-dir";
import {
  invalidGatewayManagementDeclarationError,
  loadGatewayManagementDeclaration,
} from "../../onboard/gateway-management";
import type { OpenShellGatewayTarget } from "./sandbox-observer";
import { importOpenShellSdk } from "./sdk-import.mjs";

const MAX_PEM_BYTES = 1024 * 1024;
export class OpenShellSdkPreflightUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenShellSdkPreflightUnavailableError";
  }
}

type OpenShellSdkModule = Readonly<{
  OpenShellClient: Readonly<{
    connect(
      options: Readonly<{
        caCert: Buffer;
        clientCert: Buffer;
        clientKey: Buffer;
        gateway: string;
      }>,
    ): Promise<unknown>;
  }>;
}>;

export type OpenShellSdkConnectionDeps = Readonly<{
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  loadSdk?: () => Promise<OpenShellSdkModule>;
  signal?: AbortSignal;
}>;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw Object.assign(new Error("OpenShell SDK connection timed out."), { code: "4" });
  }
}

function readPem(target: string): Buffer {
  const file = openRegularFileNoFollow(target);
  try {
    return file.readBytes(MAX_PEM_BYTES);
  } finally {
    file.close();
  }
}

export function gatewayPort(target: OpenShellGatewayTarget): number {
  if (target.kind !== "named") {
    throw new Error("OpenShell SDK connection requires an explicit gateway target");
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
  // Load the SDK lazily through native ESM so the CommonJS CLI uses its import exports.
  return (await importOpenShellSdk()) as OpenShellSdkModule;
}

/** Connect the SDK to one validated local gateway, independent of compute provider. */
export async function connectManagedOpenShellSdk(
  target: OpenShellGatewayTarget,
  deps: Pick<OpenShellSdkConnectionDeps, "env" | "homeDir" | "loadSdk" | "signal"> = {},
): Promise<unknown> {
  throwIfAborted(deps.signal);
  const port = gatewayPort(target);
  const environment = deps.env ?? process.env;
  const configuredStateDir = environment.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
  const management = environment.NEMOCLAW_GATEWAY_MANAGEMENT?.trim()
    ? loadGatewayManagementDeclaration({ env: environment })
    : null;
  if (management && !management.ok) {
    throw invalidGatewayManagementDeclarationError(management.reason);
  }
  const external =
    management?.ok && management.declaration?.mode === "externally-supervised"
      ? management.declaration
      : null;
  if (external) {
    if (!external.endpoint || !external.stateDir) {
      throw new Error("The external gateway declaration is incomplete.");
    }
    const endpoint = new URL(external.endpoint);
    const endpointPort = Number(endpoint.port || (endpoint.protocol === "https:" ? "443" : "80"));
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpointPort !== port
    ) {
      throw new Error("The external gateway declaration does not match the selected gateway.");
    }
  }
  const home = deps.homeDir ?? environment.HOME ?? os.homedir();
  const stateDir = resolveGatewayStateDirForPort({
    configured: external?.stateDir ?? configuredStateDir,
    home,
    port,
  });
  if (
    external &&
    configuredStateDir &&
    resolveGatewayStateDirForPort({ configured: configuredStateDir, home, port }) !== stateDir
  ) {
    throw new Error(
      "The external gateway declaration conflicts with the state directory override.",
    );
  }
  const gatewayName = target.kind === "named" ? target.gatewayName : "";
  const stateTarget = { gatewayName, gatewayPort: port, stateDir };
  const ownershipFailure = external
    ? externallySupervisedGatewayStateRootOwnershipFailure(stateTarget)
    : managedGatewayStateRootOwnershipFailure(
        stateTarget,
        // The canonical default root predates the explicit marker. Its fixed path,
        // owner-only directory checks, and local mTLS identity remain the legacy
        // authority boundary. Managed overrides must always carry the marker.
        {
          allowLegacyManagedState:
            !configuredStateDir &&
            stateDir === resolveDefaultGatewayStateDirForPort({ home, port }),
        },
      );
  if (ownershipFailure) {
    const message = `Unsafe OpenShell gateway state directory: ${ownershipFailure}.`;
    if (configuredStateDir || external) throw new Error(message);
    throw new OpenShellSdkPreflightUnavailableError(message);
  }
  const tlsDirectory = path.join(stateDir, "tls");
  const sdk = await (deps.loadSdk ?? loadOpenShellSdk)();
  throwIfAborted(deps.signal);
  const client = await sdk.OpenShellClient.connect({
    gateway: `https://127.0.0.1:${String(port)}`,
    caCert: readPem(path.join(tlsDirectory, "ca.crt")),
    clientCert: readPem(path.join(tlsDirectory, "client", "tls.crt")),
    clientKey: readPem(path.join(tlsDirectory, "client", "tls.key")),
  });
  throwIfAborted(deps.signal);
  return client;
}
