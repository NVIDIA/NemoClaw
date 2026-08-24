// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listMessagingProviderSuffixes } from "../messaging/channels";

const BRIDGE_PROVIDER_SUFFIXES: readonly string[] = [...listMessagingProviderSuffixes()];

export function isBridgeProviderName(name: string): boolean {
  return BRIDGE_PROVIDER_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function classifyGatewayProviderNames(names: readonly string[]): {
  bridgeNames: string[];
  credentialNames: string[];
} {
  return {
    bridgeNames: names.filter((name) => isBridgeProviderName(name)),
    credentialNames: names.filter((name) => !isBridgeProviderName(name)).sort(),
  };
}

/** @deprecated CLI output parsing belongs to the OpenShell CLI adapter. */
export function parseGatewayProviderNames(output: unknown): {
  bridgeNames: string[];
  credentialNames: string[];
} {
  const allNames = String(output ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return classifyGatewayProviderNames(allNames);
}
