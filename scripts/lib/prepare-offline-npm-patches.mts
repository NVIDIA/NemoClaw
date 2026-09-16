#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readReviewedNpmArchiveFile } from "./reviewed-npm-archive.mts";
import { FIXED_TAR_INTEGRITY, patchBundledNpmTar } from "../patch-bundled-npm-tar.mts";
import {
  FIXED_BRACE_EXPANSION_INTEGRITY,
  patchBundledNpmBraceExpansion,
} from "../patch-bundled-npm-brace-expansion.mts";
import {
  FIXED_IP_ADDRESS_INTEGRITY,
  patchBundledNpmIpAddress,
} from "./patch-bundled-npm-ip-address.mts";

import { upgradeBundledNpm } from "../upgrade-bundled-npm.mts";

const patches = [
  { name: "tar", integrity: FIXED_TAR_INTEGRITY, apply: patchBundledNpmTar },
  {
    name: "brace-expansion",
    integrity: FIXED_BRACE_EXPANSION_INTEGRITY,
    apply: patchBundledNpmBraceExpansion,
  },
  { name: "ip-address", integrity: FIXED_IP_ADDRESS_INTEGRITY, apply: patchBundledNpmIpAddress },
] as const;

export function prepareOfflineNpmPatches(
  npmRoot: string,
  archivesRoot: string,
  npmArchive: string,
): void {
  // Verify every input before changing npm; extract only private copies of verified bytes.
  const verified = patches.map((patch) => ({
    ...patch,
    bytes: readReviewedNpmArchiveFile({
      archivePath: join(archivesRoot, `${patch.name}.tgz`),
      expectedIntegrity: patch.integrity,
      label: patch.name,
      maximumBytes: 16 * 1024 * 1024,
    }),
  }));
  upgradeBundledNpm(npmRoot, { archivePath: npmArchive });
  const temporaryRoot = mkdtempSync(join(tmpdir(), "nemoclaw-offline-npm-"));
  try {
    for (const patch of verified) {
      const archive = join(temporaryRoot, `${patch.name}.tgz`);
      const replacementRoot = join(temporaryRoot, patch.name);
      writeFileSync(archive, patch.bytes, { flag: "wx", mode: 0o600 });
      mkdirSync(replacementRoot, { mode: 0o700 });
      const result = spawnSync(
        "tar",
        [
          "--extract",
          "--gzip",
          "--file",
          archive,
          "--directory",
          replacementRoot,
          "--strip-components=1",
          "--no-same-owner",
          "--no-same-permissions",
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${patch.name} extraction failed: ${result.stderr}`);
      patch.apply({ npmRoot, replacementRoot });
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [npmRoot, archivesRoot, npmArchive, ...extra] = process.argv.slice(2);
  if (!npmRoot || !archivesRoot || !npmArchive || extra.length) {
    throw new Error(
      "usage: prepare-offline-npm-patches.mts <npm-root> <archives-root> <npm-archive>",
    );
  }
  prepareOfflineNpmPatches(npmRoot, archivesRoot, npmArchive);
  process.stdout.write("Verified offline npm security patches\n");
}
