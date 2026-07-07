// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerImageInspectFormat } from "../adapters/docker";
import {
  SANDBOX_BASE_IMAGE_RESOLUTION_SOURCES,
  SANDBOX_BASE_RESOLUTION_KEY_LABEL,
  SANDBOX_BASE_RESOLUTION_LABEL,
  SANDBOX_BASE_RESOLUTION_SCHEMA,
  type SandboxBaseImageResolution,
  type SandboxBaseImageResolutionMetadata,
} from "./types";

// Resolution metadata is normally well under 2 KiB. This bound leaves generous
// growth room while limiting work performed on an untrusted Docker label.
export const MAX_ENCODED_RESOLUTION_LABEL_LENGTH = 8_192;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const VALID_RESOLUTION_SOURCES = new Set<SandboxBaseImageResolution["source"]>(
  SANDBOX_BASE_IMAGE_RESOLUTION_SOURCES,
);

export function readSandboxBaseImageResolutionMetadata(
  sandboxImageRef: string | null | undefined,
): SandboxBaseImageResolutionMetadata | null {
  if (!sandboxImageRef) return null;
  const labelsOutput = dockerImageInspectFormat("{{json .Config.Labels}}", sandboxImageRef, {
    ignoreError: true,
  });
  if (!labelsOutput) return null;
  try {
    return parseSandboxBaseImageResolutionLabels(JSON.parse(labelsOutput));
  } catch {
    return null;
  }
}

export function parseSandboxBaseImageResolutionLabels(
  labels: unknown,
): SandboxBaseImageResolutionMetadata | null {
  try {
    if (!labels || typeof labels !== "object") return null;
    const encoded = (labels as Record<string, unknown>)[SANDBOX_BASE_RESOLUTION_LABEL];
    if (
      typeof encoded !== "string" ||
      !encoded ||
      encoded.length > MAX_ENCODED_RESOLUTION_LABEL_LENGTH ||
      !BASE64URL_RE.test(encoded)
    ) {
      return null;
    }
    // Decode and parse inside this function's outer guard so every malformed
    // untrusted label fails closed through the same null-return path.
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const metadata = parsed as SandboxBaseImageResolutionMetadata;
    if (
      metadata.schema !== SANDBOX_BASE_RESOLUTION_SCHEMA ||
      typeof metadata.key !== "string" ||
      typeof metadata.imageName !== "string" ||
      typeof metadata.ref !== "string" ||
      (metadata.digest !== null && typeof metadata.digest !== "string") ||
      !VALID_RESOLUTION_SOURCES.has(metadata.source) ||
      typeof metadata.imageId !== "string" ||
      typeof metadata.os !== "string" ||
      typeof metadata.architecture !== "string" ||
      (metadata.glibcVersion !== null && typeof metadata.glibcVersion !== "string") ||
      typeof metadata.requireOpenshellSandboxAbi !== "boolean" ||
      typeof metadata.minGlibcVersion !== "string"
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

export function formatSandboxBaseImageResolutionLabels(
  metadata: SandboxBaseImageResolutionMetadata | null | undefined,
): string {
  if (!metadata) return "";
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return (
    `LABEL ${SANDBOX_BASE_RESOLUTION_KEY_LABEL}=${JSON.stringify(metadata.key)} ` +
    `${SANDBOX_BASE_RESOLUTION_LABEL}=${JSON.stringify(encoded)}`
  );
}
