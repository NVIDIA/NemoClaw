// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FERN_PREVIEW_INSTANCE =
  "nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw";

const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const instancePathSegment = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]*[A-Za-z0-9])?$/;

export function resolveFernPreviewInstance(rawValue: string | undefined): string {
  if (rawValue === undefined) {
    return DEFAULT_FERN_PREVIEW_INSTANCE;
  }

  const value = rawValue.trim();
  if (!isFernPreviewInstance(value)) {
    throw new Error(
      "FERN_STAGING_INSTANCE must use the Fern <hostname>/<path> format without flags, whitespace, a URL scheme, query, or fragment",
    );
  }
  return value;
}

export function buildFernPreviewArgs(options: {
  fernVersion: string;
  instance: string;
  previewId: string;
}): string[] {
  return [
    "--yes",
    `fern-api@${options.fernVersion}`,
    "generate",
    "--docs",
    "--instance",
    options.instance,
    "--preview",
    "--id",
    options.previewId,
    "--force",
  ];
}

function isFernPreviewInstance(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    value.includes("://") ||
    /\s/.test(value) ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }

  const [hostname, ...pathSegments] = value.split("/");
  const hostnameLabels = hostname.split(".");
  return (
    hostname.length <= 253 &&
    hostnameLabels.length >= 2 &&
    hostnameLabels.every((label) => hostnameLabel.test(label)) &&
    pathSegments.length > 0 &&
    pathSegments.every((segment) => instancePathSegment.test(segment))
  );
}

/** Prepare an isolated v0 preview whose product switcher opens v1 staging. */
export function prepareStagingProject(repo: string, destination: string): void {
  cpSync(path.join(repo, "docs"), path.join(destination, "docs"), { recursive: true });
  const fern = path.join(destination, "fern");
  cpSync(path.join(repo, "fern"), fern, {
    recursive: true,
    filter: (source) => ![".fern", ".fern-cache"].includes(path.basename(source)),
  });
  const config = path.join(fern, "docs.yml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "https://docs.nvidia.com/nemoclaw/v1/home",
      "https://nvidia-nemoclaw-staging.docs.buildwithfern.com/nemoclaw/v1/home",
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a temporary directory for the staging project");
  prepareStagingProject(path.resolve(import.meta.dirname, ".."), destination);
}
