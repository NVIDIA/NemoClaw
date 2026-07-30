// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type HermesToolGatewayCloneBroker = {
  readonly HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV: string;
  getHermesToolGatewayProviderName(sandboxName: string): string;
  getHermesInferenceProviderName(sandboxName: string): string;
  preflightHermesToolGatewayCloneBinding(sandboxName: string): void;
  stageHermesToolGatewayCloneBinding(
    sandboxName: string,
    refreshToken: string,
  ): { readonly activationToken: string; readonly brokerToken: string };
  activateHermesToolGatewayCloneBinding(
    sandboxName: string,
    refreshToken: string,
    stagedBinding: { readonly activationToken: string; readonly brokerToken: string },
  ): { readonly file: string; readonly brokerToken: string };
  discardHermesToolGatewayCloneBinding(
    sandboxName: string,
    stagedBinding: { readonly activationToken: string; readonly brokerToken: string },
  ): boolean;
  bindHermesToolGatewayCloneProviderState(
    sandboxName: string,
    refreshToken: string,
  ): { readonly file: string; readonly brokerToken: string };
  removeHermesToolGatewayProviderState(sandboxName: string): boolean;
};

/** Lazy CommonJS bridge, kept injectable so tests never start a host broker. */
export function getHermesToolGatewayCloneBroker(): HermesToolGatewayCloneBroker {
  return require("./hermes-tool-gateway-broker") as HermesToolGatewayCloneBroker;
}
