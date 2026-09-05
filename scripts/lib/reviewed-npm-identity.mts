#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

type ReviewedNpmIdentity = Readonly<{
  npmArchiveSha256: string;
  npmIntegrity: string;
  npmVersion: string;
  registryOrigin: string;
}>;

const identity = JSON.parse(
  readFileSync(new URL("../../ci/reviewed-npm-audit.json", import.meta.url), "utf8"),
) as ReviewedNpmIdentity;

if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(identity.npmVersion)) {
  throw new Error("reviewed npm audit configuration has an invalid npmVersion");
}
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(identity.npmIntegrity)) {
  throw new Error("reviewed npm audit configuration has an invalid npmIntegrity");
}
if (!/^[a-f0-9]{64}$/u.test(identity.npmArchiveSha256)) {
  throw new Error("reviewed npm audit configuration has an invalid npmArchiveSha256");
}
if (identity.registryOrigin !== "https://registry.npmjs.org/") {
  throw new Error("reviewed npm audit configuration has an invalid registryOrigin");
}

export const REVIEWED_NPM_VERSION = identity.npmVersion;
export const REVIEWED_NPM_INTEGRITY = identity.npmIntegrity;
export const REVIEWED_NPM_ARCHIVE_SHA256 = identity.npmArchiveSha256;
export const REVIEWED_NPM_TARBALL = new URL(
  `npm/-/npm-${REVIEWED_NPM_VERSION}.tgz`,
  identity.registryOrigin,
).href;
