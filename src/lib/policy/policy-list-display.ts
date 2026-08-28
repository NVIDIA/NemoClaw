// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatPresetProvenanceSuffix, type PresetProvenanceContext } from "./preset-provenance";

interface PolicyListPresetRowOptions {
  preset: { name: string; description: string };
  inRegistry: boolean;
  inGateway: boolean | null;
  provenanceContext: PresetProvenanceContext;
}

/** Render one policy-list row from reconciled registry and gateway state. */
export function formatPolicyListPresetRow(options: PolicyListPresetRowOptions): string {
  const { preset, inRegistry, inGateway, provenanceContext } = options;
  let marker: "●" | "○";
  let stateSuffix = "";
  if (inGateway === null) {
    marker = inRegistry ? "●" : "○";
  } else if (inRegistry && inGateway) {
    marker = "●";
  } else if (!inRegistry && !inGateway) {
    marker = "○";
  } else if (inGateway) {
    marker = "●";
    stateSuffix = " (active on gateway, missing from local state)";
  } else {
    marker = "○";
    stateSuffix = " (recorded locally, not active on gateway)";
  }

  const provenanceSuffix = formatPresetProvenanceSuffix(preset.name, provenanceContext, {
    active: marker === "●",
    inRegistry,
    inGateway,
  });
  return `    ${marker} ${preset.name}${provenanceSuffix} — ${preset.description}${stateSuffix}`;
}
