// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { singleNpmPackResult } from "../../scripts/lib/reviewed-npm-archive.mts";

export type NpmPackResult = Readonly<{
  filename?: string;
  files?: ReadonlyArray<Readonly<{ path?: string }>>;
  integrity?: string;
}>;

export function parseSingleNpmPackResult(source: string): NpmPackResult {
  const parsed: unknown = JSON.parse(source);
  const result = singleNpmPackResult(parsed);
  if (result === undefined) {
    throw new Error("npm pack must return exactly one package result");
  }
  return result as NpmPackResult;
}

export function npmPackFilePaths(source: string): string[] {
  return (parseSingleNpmPackResult(source).files ?? []).flatMap(({ path }) =>
    typeof path === "string" ? [path] : [],
  );
}
