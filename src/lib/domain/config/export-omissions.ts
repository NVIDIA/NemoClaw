// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { VerifiedExportSource } from "./export-evidence";
import {
  IMAGE_POLICY_SECTIONS,
  isOpenShellProviderRule,
  OLLAMA_SERVICE_NAME,
  VLLM_SERVICE_NAME,
} from "./export-document";

/** A JSON value from the V0 source that is safe to repeat in the export report. */
export type ExportOmissionValue =
  | string
  | number
  | boolean
  | readonly ExportOmissionValue[]
  | { readonly [key: string]: ExportOmissionValue | undefined };

/** One source setting the v1 export leaves out or replaces because v1 has no equivalent. */
export interface ExportOmission {
  /** The v0 source setting, as named in the sandbox's configuration. */
  readonly field: string;
  readonly kind: "omitted" | "placeholder" | "changed" | "review";
  readonly message: string;
  /** The V0 value, when it is safe to repeat. Never a credential. */
  readonly value?: ExportOmissionValue;
  /** For `changed` entries: the V0 value and its exported spelling (`null` means omitted). */
  readonly before?: string;
  readonly after?: string | null;
}

const omitted = (field: string, why: string, value?: ExportOmission["value"]): ExportOmission => ({
  field,
  kind: "omitted",
  message: `${field} is not included in the exported YAML: ${why}`,
  ...(value === undefined ? {} : { value }),
});

function tuningOmissions(source: VerifiedExportSource): ExportOmission[] {
  const overrides = "overrides" in source.inference ? source.inference.overrides : undefined;
  const found = (["contextWindow", "reasoning", "reasoningEffort"] as const)
    .filter((key) => overrides?.[key] !== undefined)
    .map((key) =>
      omitted(`inference.${key}`, "v1 route overrides do not accept it.", overrides?.[key]),
    );
  if (source.execution?.heartbeatEvery !== undefined) {
    found.push(
      omitted(
        "execution.heartbeatEvery",
        "v1 has no equivalent setting.",
        source.execution.heartbeatEvery,
      ),
    );
  }
  return found;
}

function harnessOmissions(source: VerifiedExportSource): ExportOmission[] {
  const found: ExportOmission[] = [];
  if (source.proxy !== undefined) {
    found.push(
      omitted("proxy", "v1 has no sandbox proxy setting.", {
        host: source.proxy.host,
        port: source.proxy.port,
      }),
    );
  }
  if (source.observability !== undefined) {
    found.push(
      omitted(
        "observability",
        "no confirmed v1 equivalent (v1 has an opaque harness.telemetry section, but its mapping from v0 OTLP settings is unverified).",
        source.observability,
      ),
    );
  }
  if (source.tools !== undefined) {
    found.push(
      omitted("tools.disclosure", "v1 has no equivalent setting.", source.tools.disclosure),
    );
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
        source.interfaces,
      ),
    );
  }
  if ("serving" in source.inference) {
    const backend = source.inference.serving.backend;
    const field = `services.${backend === "ollama" ? OLLAMA_SERVICE_NAME : VLLM_SERVICE_NAME}.image`;
    found.push({
      field,
      kind: "placeholder",
      message: `${field} is a placeholder: v0 has no v1 ${backend === "ollama" ? "Ollama proxy" : "vLLM"} service image. Replace it with a v1 service image digest.`,
    });
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
  for (const [name, network] of Object.entries(networks ?? {})) {
    // Provider-composed entries are not exported, so their TLS spelling is not changed.
    if (isOpenShellProviderRule(name)) continue;
    for (const endpoint of Array.isArray(network.endpoints) ? network.endpoints : []) {
      found.add((endpoint as { tls?: unknown }).tls);
    }
  }
  return found;
}

function providerRuleOmissions(source: VerifiedExportSource): ExportOmission[] {
  const networks = (source.policy as { network_policies?: Record<string, unknown> })
    .network_policies;
  return Object.keys(networks ?? {})
    .filter(isOpenShellProviderRule)
    .map((name) =>
      omitted(
        `network_policies.${name}`,
        "OpenShell composed it from a provider attached to the source sandbox. OpenShell rejects that reserved prefix in a submitted policy and builds the entry again for each provider the destination attaches.",
      ),
    );
}

function imagePolicyOmissions(source: VerifiedExportSource): ExportOmission[] {
  const policy = source.policy as Record<string, ExportOmissionValue | undefined>;
  return IMAGE_POLICY_SECTIONS.filter((section) => policy[section] !== undefined).map((section) =>
    omitted(
      `network.policy.explicit.${section}`,
      "it describes the V0 image, and the v1 image has its own user and paths. v1 applies OpenShell defaults to sections an explicit policy omits.",
      policy[section],
    ),
  );
}

function binaryReview(source: VerifiedExportSource): ExportOmission[] {
  const networks = (source.policy as { network_policies?: Record<string, { binaries?: unknown }> })
    .network_policies;
  const paths = new Set<string>();
  for (const [name, network] of Object.entries(networks ?? {})) {
    if (isOpenShellProviderRule(name) || !Array.isArray(network.binaries)) continue;
    for (const binary of network.binaries) {
      const path = (binary as { path?: unknown }).path;
      if (typeof path === "string") paths.add(path);
    }
  }
  if (paths.size === 0) return [];
  const field = "network_policies[].binaries";
  return [
    {
      field,
      kind: "review",
      message: `${field} are executable paths in the V0 image. Check that each exists in the v1 image, or replace it.`,
      value: [...paths].sort(),
    },
  ];
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
            before: "passthrough",
            after: "skip",
            message: `${field}: passthrough is written as skip, the v1 name for a raw TLS tunnel.`,
          },
        ]
      : []),
    ...(tls.has("terminate")
      ? [
          {
            field,
            kind: "changed" as const,
            before: "terminate",
            after: null,
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
    ...imagePolicyOmissions(source),
    ...providerRuleOmissions(source),
    ...binaryReview(source),
    ...policyChanges(source),
  ];
}
