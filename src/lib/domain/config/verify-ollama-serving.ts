// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { NemoClawOllamaServingSchema } from "../../config/model";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { ObservedOllamaProxy } from "../../inference/ollama/proxy-observation";
import type {
  ExportFinding,
  ObservedExportEndpointEvidence,
  QualifiedExportSnapshot,
} from "./export-evidence";

const { Check } = require("typebox/value") as typeof TypeBoxValueModule;

function validObservation(
  observed: ObservedOllamaProxy | undefined,
): observed is ObservedOllamaProxy {
  if (!observed) return false;
  const { serving, pid } = observed;
  return (
    Check(NemoClawOllamaServingSchema, serving) &&
    serving.daemon.hostPort !== serving.proxy.hostPort &&
    Number.isInteger(pid) &&
    pid > 0 &&
    pid <= 2_147_483_647 &&
    observed.listenerAddress === "0.0.0.0"
  );
}

function validProfileVersion(version: string): boolean {
  return /^(0|[1-9][0-9]{0,19})$/u.test(version) && BigInt(version) <= 18_446_744_073_709_551_615n;
}

function hasManagedOpenAiProfile(evidence: ObservedExportEndpointEvidence | null): boolean {
  if (!evidence) return false;
  const { provider } = evidence;
  const profile = provider.managedProfile;
  if (!profile) return false;
  const version = profile.resourceVersion;
  if (profile.id !== "openai" || !validProfileVersion(version)) return false;
  if (profile.source === "builtin")
    return isDeepStrictEqual([provider.profileWorkspace, profile.scope, version], ["", "", "0"]);
  return (
    profile.source === "user" &&
    version !== "0" &&
    [
      ["", "platform"],
      [provider.workspace, "workspace"],
    ].some((binding) => isDeepStrictEqual([provider.profileWorkspace, profile.scope], binding))
  );
}

function hasOllamaOpenAiProfile(evidence: ObservedExportEndpointEvidence | null): boolean {
  const provider = evidence?.provider;
  return (
    hasManagedOpenAiProfile(evidence) ||
    (provider?.managedProfile === null &&
      (provider.profileWorkspace === "" || provider.profileWorkspace === provider.workspace))
  );
}

/** Require the retained route, live provider, proxy process, daemon, and selected model to agree. */
export function validateOllamaServing(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry: entry, inference } = snapshot;
  const observed = inference.ollamaServing;
  if (
    validObservation(observed) &&
    hasOllamaOpenAiProfile(inference.endpointEvidence) &&
    entry.workload?.kind === "managed-image" &&
    /^linux\/(?:amd64|arm64)$/u.test(entry.workload.platform ?? "") &&
    isDeepStrictEqual(
      [
        entry.agent,
        entry.openshellDriver,
        inference.topology,
        inference.provider,
        inference.api,
        inference.credentialEnv ?? OLLAMA_LOCAL_CREDENTIAL_ENV,
        inference.model,
        inference.endpoint,
        snapshot.sandbox.providerNames.filter((name) => name === inference.provider),
      ],
      [
        "openclaw",
        "docker",
        "local",
        "ollama-local",
        "openai-completions",
        OLLAMA_LOCAL_CREDENTIAL_ENV,
        observed.serving.model.servedName,
        `http://host.openshell.internal:${observed.serving.proxy.hostPort}/v1`,
        ["ollama-local"],
      ],
    )
  )
    return [];
  return [
    {
      field: "spec.services[].upstream",
      category: "drifted",
      diagnostic:
        "The attached Ollama daemon, managed proxy, model, or sandbox route could not be verified.",
    },
  ];
}
