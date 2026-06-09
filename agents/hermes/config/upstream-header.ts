// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function buildHermesUpstreamHeader(config: Record<string, unknown>): string {
  const upstream = config._nemoclaw_upstream;
  if (!upstream || typeof upstream !== "object") return "";
  const u = upstream as Record<string, unknown>;
  const provider = typeof u.provider === "string" ? u.provider : "";
  const model = typeof u.model === "string" ? u.model : "";
  if (!provider && !model) return "";

  const lines = ["# Managed by NemoClaw — Hermes configuration"];
  if (provider) lines.push(`# Upstream provider: ${provider}`);
  if (model) lines.push(`# Upstream model: ${model}`);
  lines.push("# OpenShell rewrites model.base_url to the upstream endpoint at request time.");
  return `${lines.join("\n")}\n`;
}
