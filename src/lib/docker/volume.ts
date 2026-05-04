// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun, type DockerCaptureOptions, type DockerRunOptions } from "./run";

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeVolumePrefix(prefix: string): string {
  const normalized = prefix.trim();
  if (!normalized) {
    throw new Error("prefix must be a non-empty string");
  }
  return normalized;
}

export function dockerListVolumesByPrefix(
  prefix: string,
  opts: DockerCaptureOptions = {},
): string[] {
  const normalized = normalizeVolumePrefix(prefix);
  const output = dockerCapture(["volume", "ls", "-q", "--filter", `name=${normalized}`], {
    ignoreError: true,
    ...opts,
  });
  return splitNonEmptyLines(output).filter((name) => name.startsWith(normalized));
}

export function dockerRemoveVolumes(names: readonly string[], opts: DockerRunOptions = {}) {
  if (names.length === 0) return null;
  return dockerRun(["volume", "rm", ...names], opts);
}

export function dockerRemoveVolumesByPrefix(
  prefix: string,
  opts: DockerRunOptions = {},
): string[] {
  const normalized = normalizeVolumePrefix(prefix);
  let names: string[];
  try {
    names = dockerListVolumesByPrefix(normalized, {
      ignoreError: opts.ignoreError,
    });
  } catch (error) {
    if (opts.ignoreError) return [];
    throw error;
  }
  if (names.length === 0) return names;
  dockerRemoveVolumes(names, opts);
  return names;
}
