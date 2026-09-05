// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type NpmPackResult = Readonly<{
  filename?: string;
  files?: ReadonlyArray<Readonly<{ path?: string }>>;
  integrity?: string;
}>;

export function parseSingleNpmPackResult(source: string): NpmPackResult {
  const parsed: unknown = JSON.parse(source);
  const entries = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? Object.values(parsed)
      : [];
  if (entries.length !== 1 || typeof entries[0] !== "object" || entries[0] === null) {
    throw new Error("npm pack must return exactly one package result");
  }
  return entries[0] as NpmPackResult;
}

export function npmPackFilePaths(source: string): string[] {
  return (parseSingleNpmPackResult(source).files ?? []).flatMap(({ path }) =>
    typeof path === "string" ? [path] : [],
  );
}
