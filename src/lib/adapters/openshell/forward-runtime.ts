// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellForwardAdapter,
  OpenShellForwardIdentity,
  OpenShellForwardLocalHost,
} from "./forward";
import { createCliOpenShellForwardAdapter } from "./forward-cli";
import { resolveOpenshell } from "./resolve";

export type OpenShellForwardRuntimeAuthority = Readonly<{
  gatewayEndpoint: string;
  gatewayName: string;
  workspace: string;
  localTlsDir?: string;
}>;

export function createOpenShellForwardAdapterForAuthority(
  authority: OpenShellForwardRuntimeAuthority,
  options: Readonly<{
    environment?: NodeJS.ProcessEnv;
    executable?: string;
    legacyForwardWorkspaceSelection?: "explicit" | "implicit-default";
  }> = {},
): OpenShellForwardAdapter {
  const environment = options.environment ?? process.env;
  const executable = options.executable ?? resolveOpenshell({ env: environment });
  if (!executable) throw new Error("OpenShell executable authority is unavailable.");
  return createCliOpenShellForwardAdapter({
    executable,
    environment,
    gatewayEndpoint: authority.gatewayEndpoint,
    ...(options.legacyForwardWorkspaceSelection
      ? { legacyForwardWorkspaceSelection: options.legacyForwardWorkspaceSelection }
      : {}),
    runtimeSelection: {
      gatewayName: authority.gatewayName,
      workspace: authority.workspace,
      ...(authority.localTlsDir ? { localTlsDir: authority.localTlsDir } : {}),
    },
  });
}

export function openShellForwardIdentity(
  authority: OpenShellForwardRuntimeAuthority,
  sandboxName: string,
  localHost: OpenShellForwardLocalHost,
  port: number,
): OpenShellForwardIdentity {
  return {
    gatewayEndpoint: authority.gatewayEndpoint,
    gatewayName: authority.gatewayName,
    workspace: authority.workspace,
    sandboxName,
    localHost,
    port,
  };
}
