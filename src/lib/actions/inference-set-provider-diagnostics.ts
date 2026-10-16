// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellInferenceRouteMutationError } from "../adapters/openshell/inference-route";
import {
  type CaptureOpenShellInferenceRoute,
  createCliOpenShellInferenceRouteMutator,
  createCliOpenShellInferenceRouteObserver,
} from "../adapters/openshell/inference-route-cli";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import { CLI_NAME } from "../cli/branding";
import { classifyGatewayProviderNames } from "../credentials/provider-list";
import { redactFullWithUrls } from "../security/redact";

const OPEN_SHELL_DIAGNOSTIC_TIMEOUT_MS = 5_000;

interface ProviderDiagnosticDeps {
  providerAdapter: OpenShellProviderAdapter;
  log: (message: string) => void;
}

export function redactInferenceSetRouteDiagnostic(value: string): string {
  return redactFullWithUrls(value);
}

export function createDefaultInferenceSetRouteMutator(capture: CaptureOpenShellInferenceRoute) {
  return createCliOpenShellInferenceRouteMutator(capture, {
    redactDiagnostic: redactInferenceSetRouteDiagnostic,
  });
}

export function createDefaultInferenceSetRouteObserver(capture: CaptureOpenShellInferenceRoute) {
  return createCliOpenShellInferenceRouteObserver(capture);
}

export async function queryRegisteredGatewayProviders(
  gatewayName: string,
  deps: ProviderDiagnosticDeps,
): Promise<string[] | undefined> {
  try {
    const result = await deps.providerAdapter.listProviders({
      target: namedOpenShellGateway(gatewayName),
      timeoutMs: OPEN_SHELL_DIAGNOSTIC_TIMEOUT_MS,
    });
    if (result.ok) {
      return classifyGatewayProviderNames(result.value.names).credentialNames;
    }
  } catch (_error: unknown) {
    // #5924: intentionally treat every thrown query or parsing error identically.
    // The provider-list lookup is secondary diagnostics; its error must not mask
    // the primary route failure, and the static warning below remains observable.
  }
  deps.log("  ⚠ Could not query registered OpenShell providers while formatting the failure.");
  return undefined;
}

export async function buildInferenceSetFailure(
  error: OpenShellInferenceRouteMutationError,
  ambiguous: boolean,
  gatewayName: string,
  deps: ProviderDiagnosticDeps,
): Promise<{ exitCode: number; message: string }> {
  const providerNotFound = error.kind === "command" && error.reason === "provider_not_found";
  const registeredProviders = providerNotFound
    ? await queryRegisteredGatewayProviders(gatewayName, deps)
    : undefined;
  const providerLine =
    registeredProviders === undefined
      ? ""
      : registeredProviders.length > 0
        ? `\nRegistered providers: ${registeredProviders.join(", ")}`
        : "\nNo providers registered";
  const tip = providerNotFound
    ? `\nTip: register a new provider with \`${CLI_NAME} onboard\`.`
    : "";
  const recovery = ambiguous
    ? `\nInspect gateway '${gatewayName}', then rerun the same \`${CLI_NAME} inference set\` command.`
    : "";
  return {
    exitCode:
      error.kind === "command" && error.exitCode !== null && error.exitCode !== 0
        ? error.exitCode
        : 1,
    message: `${error.message}${providerLine}${tip}${recovery}`,
  };
}
