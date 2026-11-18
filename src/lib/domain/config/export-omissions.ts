// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { VerifiedExportSource } from "./export-evidence";

/** One source setting the v1 export leaves out or replaces because v1 has no equivalent. */
export interface ExportOmission {
  /** The v0 source setting, as named in the sandbox's configuration. */
  readonly field: string;
  readonly kind: "omitted" | "placeholder" | "changed";
  readonly message: string;
}

const omitted = (field: string, why: string): ExportOmission => ({
  field,
  kind: "omitted",
  message: `${field} is not included in the exported YAML: ${why}`,
});

function tuningOmissions(source: VerifiedExportSource): ExportOmission[] {
  const overrides = "overrides" in source.inference ? source.inference.overrides : undefined;
  const found = (["contextWindow", "reasoning", "reasoningEffort"] as const)
    .filter((key) => overrides?.[key] !== undefined)
    .map((key) => omitted(`inference.${key}`, "v1 route overrides do not accept it."));
  if (source.execution?.heartbeatEvery !== undefined) {
    found.push(omitted("execution.heartbeatEvery", "v1 has no equivalent setting."));
  }
  return found;
}

function harnessOmissions(source: VerifiedExportSource): ExportOmission[] {
  const found: ExportOmission[] = [];
  if (source.proxy !== undefined) {
    found.push(omitted("proxy", "v1 has no sandbox proxy setting."));
  }
  if (source.observability !== undefined) {
    found.push(
      omitted(
        "observability",
        "no confirmed v1 equivalent (v1 has an opaque harness.telemetry section, but its mapping from v0 OTLP settings is unverified).",
      ),
    );
  }
  if (source.tools !== undefined) {
    found.push(omitted("tools.disclosure", "v1 has no equivalent setting."));
  }
  return found;
}

function fabricImageOmissions(source: VerifiedExportSource): ExportOmission[] {
  const found: ExportOmission[] = [];
  if (source.agent !== "langchain-deepagents-code") {
    found.push(
      omitted(
        "interfaces",
        "no confirmed v1 equivalent: v0 interface ports and v1 interface ports are not known to mean the same thing.",
      ),
    );
  }
  found.push({
    field: "image.ref",
    kind: "placeholder",
    message:
      "image.ref is a placeholder: v0 agent images do not ship Fabric or its adapter. Replace it with a v1 agent image digest.",
  });
  return found;
}

function endpointTls(source: VerifiedExportSource): Set<unknown> {
  const networks = (source.policy as { network_policies?: Record<string, { endpoints?: unknown }> })
    .network_policies;
  const found = new Set<unknown>();
  for (const network of Object.values(networks ?? {})) {
    for (const endpoint of Array.isArray(network.endpoints) ? network.endpoints : []) {
      found.add((endpoint as { tls?: unknown }).tls);
    }
  }
  return found;
}

function policyChanges(source: VerifiedExportSource): ExportOmission[] {
  const tls = endpointTls(source);
  const field = "network_policies[].endpoints[].tls";
  return [
    ...(tls.has("passthrough")
      ? [
          {
            field,
            kind: "changed" as const,
            message: `${field}: passthrough is written as skip, the v1 name for a raw TLS tunnel.`,
          },
        ]
      : []),
    ...(tls.has("terminate")
      ? [
          {
            field,
            kind: "changed" as const,
            message: `${field}: terminate is written by omitting tls, which is v1's automatic TLS termination.`,
          },
        ]
      : []),
  ];
}

/**
 * The single collection point for what the export does not carry over. The command prints one
 * warning per entry, and a structured report can read the same list. `changed` entries are
 * values the export rewrote to their v1 spelling.
 */
export function exportOmissions(source: VerifiedExportSource): readonly ExportOmission[] {
  return [
    ...harnessOmissions(source),
    ...tuningOmissions(source),
    ...fabricImageOmissions(source),
    ...policyChanges(source),
  ];
}
