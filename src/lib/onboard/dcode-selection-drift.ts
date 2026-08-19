// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxInferenceConfig } from "../inference/config";
import { resolveManagedDcodeIdentity } from "../inference/managed-dcode/identity";
import type { SelectionDrift } from "./selection-drift";

export type DcodeInferenceIdentity = {
  route: string;
  provider: string;
  model: string;
  endpoint: string;
};

export type DcodeSelectionDriftDeps = {
  requestedEndpointUrl?: string | null;
  runCaptureOpenshell(
    args: string[],
    options?: { ignoreError?: boolean },
  ): string | null | undefined;
};

export type DcodeSelectionDriftReader = (
  sandboxName: string,
  requestedProvider: string | null,
  requestedModel: string | null,
  preferredInferenceApi: string | null,
  requestedEndpointUrl: string | null,
) => SelectionDrift;

const IDENTITY_FIELDS = ["Route", "Provider", "Model", "Endpoint"] as const;
type IdentityField = (typeof IDENTITY_FIELDS)[number];

export function usesManagedDcodeIdentity(
  agentName: string | null | undefined,
  fromDockerfile: string | null | undefined,
): boolean {
  return agentName === "langchain-deepagents-code" && !fromDockerfile;
}

export function requiresSelectionRecreate(
  drift: Pick<SelectionDrift, "changed" | "unknown">,
  managedDcode: boolean,
): boolean {
  // Managed DCode fails closed on any selection drift (known or unknown) to
  // enforce routing integrity; ordinary agents recreate only on confirmed known drift.
  return drift.changed && (!drift.unknown || managedDcode);
}

const UNKNOWN_SELECTION_DRIFT: SelectionDrift = {
  changed: true,
  providerChanged: false,
  modelChanged: false,
  existingProvider: null,
  existingModel: null,
  unknown: true,
};

export function parseDcodeInferenceIdentity(
  output: string | null | undefined,
): DcodeInferenceIdentity | null {
  if (!output) return null;

  const values = new Map<IdentityField, string>();
  for (const line of output.split(/\r?\n/u)) {
    const prefix = line.match(/^(Route|Provider|Model|Endpoint):/u);
    if (!prefix) continue;

    const match = line.match(/^(Route|Provider|Model|Endpoint):[ \t]+(\S(?:.*\S)?)$/u);
    if (!match) return null;

    const field = match[1] as IdentityField;
    const value = match[2];
    if (values.has(field) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
    values.set(field, value);
  }

  if (IDENTITY_FIELDS.some((field) => !values.has(field))) return null;
  return {
    route: values.get("Route") as string,
    provider: values.get("Provider") as string,
    model: values.get("Model") as string,
    endpoint: values.get("Endpoint") as string,
  };
}

export function getExpectedDcodeInferenceIdentity(
  requestedProvider: string | null,
  requestedModel: string | null,
  preferredInferenceApi: string | null,
  requestedEndpointUrl?: string | null,
): DcodeInferenceIdentity | null {
  if (requestedModel === null) return null;

  const route = getSandboxInferenceConfig(requestedModel, requestedProvider, preferredInferenceApi);
  const managedIdentity = resolveManagedDcodeIdentity(
    requestedProvider,
    requestedModel,
    requestedEndpointUrl,
  );
  return {
    route: route.providerKey,
    provider:
      managedIdentity.provider === "openrouter"
        ? managedIdentity.provider
        : requestedProvider?.trim() || route.providerKey,
    model: managedIdentity.defaultModel,
    endpoint: route.inferenceBaseUrl,
  };
}

export function getDcodeSelectionDrift(
  sandboxName: string,
  requestedProvider: string | null,
  requestedModel: string | null,
  preferredInferenceApi: string | null,
  deps: DcodeSelectionDriftDeps,
): SelectionDrift {
  const expected = getExpectedDcodeInferenceIdentity(
    requestedProvider,
    requestedModel,
    preferredInferenceApi,
    deps.requestedEndpointUrl,
  );
  if (!sandboxName || !expected) return { ...UNKNOWN_SELECTION_DRIFT };

  let output: string | null | undefined;
  try {
    output = deps.runCaptureOpenshell(
      ["sandbox", "exec", "-n", sandboxName, "--", "dcode", "identity"],
      { ignoreError: true },
    );
  } catch {
    return { ...UNKNOWN_SELECTION_DRIFT };
  }

  const existing = parseDcodeInferenceIdentity(output);
  if (!existing) return { ...UNKNOWN_SELECTION_DRIFT };

  const providerChanged =
    existing.provider !== expected.provider ||
    existing.route !== expected.route ||
    existing.endpoint !== expected.endpoint;
  const modelChanged = existing.model !== expected.model;
  return {
    changed: providerChanged || modelChanged,
    providerChanged,
    modelChanged,
    existingProvider: existing.provider,
    existingModel: existing.model,
    unknown: false,
  };
}

export function createDcodeSelectionDriftReader(
  runCaptureOpenshell: DcodeSelectionDriftDeps["runCaptureOpenshell"],
): DcodeSelectionDriftReader {
  return (
    sandboxName,
    requestedProvider,
    requestedModel,
    preferredInferenceApi,
    requestedEndpointUrl,
  ) =>
    getDcodeSelectionDrift(sandboxName, requestedProvider, requestedModel, preferredInferenceApi, {
      runCaptureOpenshell,
      requestedEndpointUrl,
    });
}
