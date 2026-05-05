// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runCapture } from "./runner";

const MANIFEST_HOST = "https://registry.ollama.ai";
const PROBE_TIMEOUT_SECONDS = 3;
const MANIFEST_ACCEPT_HEADER =
  "Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json";

const FALLBACK_SIZE_BYTES: Readonly<Record<string, number>> = {
  "qwen2.5:7b": 4_683_073_184,
  "nemotron-3-nano:30b": 19_000_000_000,
};

export type CaptureFn = (cmd: readonly string[], opts?: { ignoreError?: boolean }) => string;

export type SizeSource = "registry" | "fallback";

export interface SizeLookup {
  bytes: number;
  source: SizeSource;
}

function splitNamespaceAndTag(model: string): { namespace: string; tag: string } | null {
  const [name, tag = "latest"] = model.split(":", 2);
  if (!name || !tag) return null;
  const namespace = name.includes("/") ? name : `library/${name}`;
  return { namespace, tag };
}

export function buildManifestUrl(model: string): string | null {
  const parts = splitNamespaceAndTag(model);
  if (!parts) return null;
  return `${MANIFEST_HOST}/v2/${parts.namespace}/manifests/${parts.tag}`;
}

export function probeRegistrySize(model: string, capture: CaptureFn = runCapture): number | null {
  const url = buildManifestUrl(model);
  if (!url) return null;
  const body = capture(
    [
      "curl",
      "-sfL",
      "--max-time",
      String(PROBE_TIMEOUT_SECONDS),
      "-H",
      MANIFEST_ACCEPT_HEADER,
      url,
    ],
    { ignoreError: true },
  );
  if (!body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const layers = (parsed as { layers?: unknown }).layers;
  if (!Array.isArray(layers) || layers.length === 0) return null;

  let total = 0;
  for (const layer of layers) {
    if (layer === null || typeof layer !== "object") return null;
    const size = (layer as { size?: unknown }).size;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
    total += size;
  }
  return total > 0 ? total : null;
}

export function getOllamaModelSize(
  model: string,
  capture: CaptureFn = runCapture,
): SizeLookup | null {
  const live = probeRegistrySize(model, capture);
  if (live !== null) return { bytes: live, source: "registry" };
  const fallback = FALLBACK_SIZE_BYTES[model];
  if (typeof fallback === "number") return { bytes: fallback, source: "fallback" };
  return null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "size unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value.toFixed(0) : value.toFixed(2);
  return `${rounded} ${units[unit]}`;
}

export function formatModelSize(lookup: SizeLookup | null): string {
  if (!lookup) return "size unknown";
  const label = formatBytes(lookup.bytes);
  return lookup.source === "fallback" ? `${label} (estimated)` : label;
}
