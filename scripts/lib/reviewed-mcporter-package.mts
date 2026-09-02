#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";

const REVIEWED_MCPORTER_PACKAGE = Object.freeze({
  integrity:
    "sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==",
  tarballUrl: "https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz",
  version: "0.7.3",
});

export function resolveReviewedMcporterPackage(
  version: string,
  integrity: string,
  tarballUrl: string,
): Readonly<{ integrity: string; tarballUrl: string; version: string }> {
  if (version !== REVIEWED_MCPORTER_PACKAGE.version) {
    throw new Error(`mcporter ${version} has no committed npm integrity pin`);
  }
  if (
    integrity !== REVIEWED_MCPORTER_PACKAGE.integrity ||
    tarballUrl !== REVIEWED_MCPORTER_PACKAGE.tarballUrl
  ) {
    throw new Error(`mcporter ${version} does not match the committed npm package identity`);
  }
  return REVIEWED_MCPORTER_PACKAGE;
}

export function main(argv = process.argv.slice(2)): void {
  if (argv.length !== 3) {
    throw new Error("expected mcporter version, integrity, and tarball URL");
  }
  const reviewed = resolveReviewedMcporterPackage(argv[0], argv[1], argv[2]);
  process.stdout.write(`${reviewed.integrity} ${reviewed.tarballUrl}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown mcporter package error");
    process.exitCode = 1;
  }
}
