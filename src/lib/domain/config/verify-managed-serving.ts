// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import {
  EXPORTED_VLLM_PROFILE_ID,
  EXPORTED_VLLM_RECIPE_ID,
  NemoClawManagedVllmServingSchema,
  type NemoClawManagedVllmServing,
} from "../../config/model";
import type { ServingProfileProvenance } from "../../inference/serving/types";
import type {
  ExportFinding,
  QualifiedExportSnapshot,
  ObservedManagedVllmRuntime,
  ObservedExportEndpointEvidence,
} from "./export-evidence";

const { Check } = require("typebox/value") as typeof TypeBoxValueModule;

function validRuntimeIdentity(observed: ObservedManagedVllmRuntime): boolean {
  return (
    Check(NemoClawManagedVllmServingSchema, observed.serving) &&
    /^[a-f0-9]{64}$/.test(observed.containerId) &&
    /^sha256:[a-f0-9]{64}$/.test(observed.imageId) &&
    /^[a-f0-9]{64}$/.test(observed.networkId) &&
    observed.startedAt.length > 0 &&
    observed.startedAt.length <= 64
  );
}

function matchesProvenance(
  serving: NemoClawManagedVllmServing,
  recorded: ServingProfileProvenance,
): boolean {
  return isDeepStrictEqual(
    [
      recorded.schemaVersion,
      recorded.catalogDigest,
      recorded.preset.id,
      recorded.preset.digest,
      recorded.recipe.id,
      recorded.recipe.digest,
      recorded.recipe.backend,
      recorded.model,
      recorded.runtimeImage,
    ],
    [
      1,
      serving.catalogDigest,
      EXPORTED_VLLM_PROFILE_ID,
      serving.profile.digest,
      EXPORTED_VLLM_RECIPE_ID,
      serving.recipe.digest,
      "vllm",
      { id: serving.model.id, revision: serving.model.revision },
      serving.runtime.image.ref,
    ],
  );
}

function validProfileVersion(version: string): boolean {
  return /^(0|[1-9][0-9]{0,19})$/.test(version) && BigInt(version) <= 18446744073709551615n;
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

export function validateManagedServing(snapshot: QualifiedExportSnapshot): ExportFinding[] {
  const { registry: entry, inference } = snapshot;
  const observed = inference.managedServing;
  const recorded = entry.servingProfileProvenance;
  const invalid = () => [
    {
      field: "spec.inferenceProviders[].serving",
      category: "drifted" as const,
      diagnostic: "The fixed managed serving identity, provenance, or route could not be verified.",
    },
  ];
  if (!observed || !recorded) return invalid();
  const serving = observed.serving;
  if (
    !validRuntimeIdentity(observed) ||
    !isDeepStrictEqual(
      [
        entry.agent,
        entry.openshellDriver,
        entry.workload?.kind,
        entry.workload?.kind === "managed-image" ? entry.workload.platform : null,
        snapshot.sandbox.providerNames.filter((name) => name === inference.provider),
        inference.provider,
        inference.api,
        inference.credentialEnv,
        inference.model,
        inference.endpoint,
      ],
      [
        "openclaw",
        "docker",
        "managed-image",
        "linux/amd64",
        ["vllm-local"],
        "vllm-local",
        "openai-completions",
        null,
        serving.model.servedName,
        `http://host.openshell.internal:${String(serving.hostPort)}/v1`,
      ],
    ) ||
    !hasManagedOpenAiProfile(inference.endpointEvidence) ||
    !matchesProvenance(observed.serving, recorded)
  )
    return invalid();
  return [];
}
