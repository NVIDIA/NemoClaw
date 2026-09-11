// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import { NemoClawOllamaServingSchema } from "../../config/model";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { ObservedOllamaProxy } from "../../inference/ollama/proxy-observation";
import type { ExportFinding, QualifiedExportSnapshot } from "./export-evidence";
import { hasManagedOpenAiProfile } from "./verify-managed-serving";

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

export function validateOllamaServing(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry: entry, inference } = snapshot;
  const observed = inference.ollamaServing;
  if (
    validObservation(observed) &&
    hasManagedOpenAiProfile(inference.endpointEvidence) &&
    entry.workload?.kind === "managed-image" &&
    /^linux\/(?:amd64|arm64)$/u.test(entry.workload.platform ?? "") &&
    isDeepStrictEqual(
      [
        entry.agent,
        entry.openshellDriver,
        inference.topology,
        inference.provider,
        inference.api,
        inference.credentialEnv,
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
      field: "spec.inferenceProviders[].serving",
      category: "drifted",
      diagnostic:
        "The attached Ollama daemon, managed proxy, model, or sandbox route could not be verified.",
    },
  ];
}
