// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface ConfigExportArtifactWriter {
  writeText(artifactName: string, contents: string): Promise<unknown>;
}

const MAX_PERCENT_DECODE_PASSES = 8;

export function encodedSensitiveValues(values: readonly string[]): string[] {
  const encoded = new Set<string>();
  for (const value of values) {
    if (value.length === 0) continue;
    const base64 = Buffer.from(value, "utf8").toString("base64");
    encoded.add(base64);
    encoded.add(base64.replace(/=+$/u, ""));
    const base64url = base64.replace(/\+/gu, "-").replace(/\//gu, "_");
    encoded.add(base64url);
    encoded.add(base64url.replace(/=+$/u, ""));
  }
  return [...encoded];
}

function decodePercentEncodedText(raw: string): string | null {
  let decoded = raw;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
}

function normalizedSecretScanText(raw: string): string | null {
  const percentDecoded = decodePercentEncodedText(raw);
  if (percentDecoded === null) return null;
  const decodedEscapes = percentDecoded
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\U([0-9a-f]{8})/gu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/\\[nrt]/gu, "");
  return decodedEscapes.replace(/[\s#'"`>|\\]/gu, "");
}

export function containsSensitiveText(raw: string, values: readonly string[]): boolean {
  const normalizedRaw = normalizedSecretScanText(raw);
  if (normalizedRaw === null) return true;
  return [...values, ...encodedSensitiveValues(values)].some((value) => {
    if (value.length === 0) return false;
    const normalizedValue = normalizedSecretScanText(value);
    return normalizedValue === null || normalizedRaw.includes(normalizedValue);
  });
}

export function assertNoKnownSecretInConfigExport(
  raw: string,
  secretValues: readonly string[],
): void {
  if (containsSensitiveText(raw, secretValues)) {
    throw new Error("config export exposed a known fixture secret");
  }
}

export async function writeSecretFreeConfigExportArtifact(
  writer: ConfigExportArtifactWriter,
  artifactName: string,
  raw: string,
  secretValues: readonly string[],
): Promise<void> {
  assertNoKnownSecretInConfigExport(raw, secretValues);
  await writer.writeText(artifactName, raw);
}
