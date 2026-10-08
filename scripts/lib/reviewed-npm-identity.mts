#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { parseReviewedNpmIdentityConfig, reviewedNpmTarball } from "./reviewed-npm-audit.mts";

export function resolveReviewedNpmImageIdentity(contents: string) {
  const identity = parseReviewedNpmIdentityConfig(contents);
  return { ...identity, npmTarball: reviewedNpmTarball(identity) };
}

const identity = resolveReviewedNpmImageIdentity(
  readFileSync(new URL("../../ci/reviewed-npm-audit.json", import.meta.url), "utf8"),
);

export const REVIEWED_NPM_VERSION = identity.npmVersion;
export const REVIEWED_NPM_INTEGRITY = identity.npmIntegrity;
export const REVIEWED_NPM_ARCHIVE_SHA256 = identity.npmArchiveSha256;
export const REVIEWED_NPM_TARBALL = identity.npmTarball;
