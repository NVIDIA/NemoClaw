// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dockerInfoFormat } from "../adapters/docker";
import { ROOT } from "../runner";
import {
  getSourceShortShaTags,
  getVersionedBaseImageTags,
  normalizeBaseImageInputPaths,
} from "./source-identity";
import {
  OPENSHELL_SANDBOX_MIN_GLIBC,
  type ResolveBaseImageOptions,
  SANDBOX_BASE_RESOLUTION_SCHEMA,
} from "./types";

function hashBaseImageInputs(
  rootDir: string,
  dockerfilePath: string,
  inputPaths: string[] = [],
): string {
  const hash = crypto.createHash("sha256");
  const paths = normalizeBaseImageInputPaths(rootDir, [dockerfilePath, ...inputPaths]).sort();
  for (const relativePath of paths) {
    hash.update(relativePath);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(path.join(rootDir, relativePath)));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function dockerPlatform(): string {
  const reported = dockerInfoFormat("{{.OSType}}/{{.Architecture}}", {
    ignoreError: true,
    timeout: 2_000,
  }).trim();
  return reported && reported !== "/" ? reported : `${process.platform}/${process.arch}`;
}

export function createSandboxBaseImageResolutionKey(options: ResolveBaseImageOptions): string {
  const env = options.env || process.env;
  const rootDir = options.rootDir || ROOT;
  const override = options.envVar ? String(env[options.envVar] || "").trim() : "";
  const material = {
    schema: SANDBOX_BASE_RESOLUTION_SCHEMA,
    imageName: options.imageName,
    override,
    pinnedRemoteRef: options.pinnedRemoteRef || null,
    ...(options.preferPinnedRemoteRef === true ? { preferPinnedRemoteRef: true } : {}),
    versionTags: getVersionedBaseImageTags(rootDir, env),
    sourceTags: getSourceShortShaTags(rootDir, env),
    localTag: options.localTag,
    inputFingerprint: hashBaseImageInputs(rootDir, options.dockerfilePath, options.inputPaths),
    platform: dockerPlatform(),
    requireOpenshellSandboxAbi: options.requireOpenshellSandboxAbi === true,
    minGlibcVersion: options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
    validationDescription: options.validationDescription || null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
