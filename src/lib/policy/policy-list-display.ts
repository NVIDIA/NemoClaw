// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatPresetProvenanceSuffix, type PresetProvenanceContext } from "./preset-provenance";

interface PolicyListPresetRowOptions {
  preset: { name: string; description: string };
  observedInOpenShell: boolean | null;
  provenanceContext: PresetProvenanceContext;
}

/** Render one policy-list row from current OpenShell state. */
export function formatPolicyListPresetRow(options: PolicyListPresetRowOptions): string {
  const { preset, observedInOpenShell, provenanceContext } = options;
  const marker = observedInOpenShell === true ? "●" : "○";

  const provenanceSuffix = formatPresetProvenanceSuffix(preset.name, provenanceContext, {
    active: marker === "●",
    observedInOpenShell,
  });
  return `    ${marker} ${preset.name}${provenanceSuffix} — ${preset.description}`;
}
