// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type HermesToolGatewayProviderOwner = {
  readonly name: string;
  readonly agent?: string | null;
  readonly hermesInferenceProvider?: string;
  readonly hermesToolGateways?: readonly string[];
};

export type HermesToolGatewayCloneBroker = {
  readonly HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV: string;
  getHermesToolGatewayProviderName(sandboxName: string): string;
  getHermesInferenceProviderName(sandboxName: string): string;
  preflightHermesToolGatewayCloneBinding(sandboxName: string): void;
  stageHermesToolGatewayCloneBinding(
    sandboxName: string,
    refreshToken: string,
    options?: { readonly requestId?: string },
  ): {
    readonly activationToken: string;
    readonly brokerToken: string;
    readonly requestId: string;
  };
  activateHermesToolGatewayCloneBinding(
    sandboxName: string,
    refreshToken: string,
    stagedBinding: {
      readonly activationToken: string;
      readonly brokerToken: string;
      readonly requestId?: string;
    },
  ): { readonly file: string; readonly brokerToken: string };
  discardHermesToolGatewayCloneBinding(
    sandboxName: string,
    stagedBinding: {
      readonly activationToken: string;
      readonly brokerToken: string;
      readonly requestId?: string;
    },
  ): boolean;
  bindHermesToolGatewayCloneProviderState(
    sandboxName: string,
    refreshToken: string,
  ): { readonly file: string; readonly brokerToken: string };
  removeHermesToolGatewayProviderState(sandboxName: string): boolean;
  removeHermesToolGatewayProviderStateForSandboxEntry(
    entry: HermesToolGatewayProviderOwner,
  ): boolean;
};

/** Lazy CommonJS bridge, kept injectable so tests never start a host broker. */
export function getHermesToolGatewayCloneBroker(): HermesToolGatewayCloneBroker {
  return require("./hermes-tool-gateway-broker") as HermesToolGatewayCloneBroker;
}
