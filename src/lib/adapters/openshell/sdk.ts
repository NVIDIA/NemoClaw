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
import type { OpenShellGatewayTarget } from "./sandbox-observer";
import { importOpenShellSdk } from "./sdk-import.mjs";

const MAX_PEM_BYTES = 1024 * 1024;
export class OpenShellSdkPreflightUnavailableError extends Error {}

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
}>;

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
  // Keep the optional reviewed package load lazy so source-only development can
  // still compile before CI stages the private SDK artifact.
  return (await importOpenShellSdk()) as OpenShellSdkModule;
}

/** Connect the SDK directly to one managed gateway, independent of compute provider. */
export async function connectManagedOpenShellSdk(
  target: OpenShellGatewayTarget,
  deps: Pick<OpenShellSdkConnectionDeps, "env" | "homeDir" | "loadSdk"> = {},
): Promise<unknown> {
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
