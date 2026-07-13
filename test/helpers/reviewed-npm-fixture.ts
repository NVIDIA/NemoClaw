// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

type ReviewedPackageFixture = Readonly<{
  integrity: string;
  packageSpec: string;
  tarballUrl: string;
}>;

export function writeReviewedNpmFixture(
  fixturePath: string,
  logPath: string,
  packages: readonly ReviewedPackageFixture[],
): void {
  const metadataCases = packages.flatMap((reviewed) => [
    `  ${JSON.stringify(`${reviewed.packageSpec}|dist.integrity`)}) printf '%s\\n' ${JSON.stringify(reviewed.integrity)} ;;`,
    `  ${JSON.stringify(`${reviewed.packageSpec}|dist.tarball`)}) printf '%s\\n' ${JSON.stringify(reviewed.tarballUrl)} ;;`,
  ]);
  const packCases = packages.map((reviewed) => {
    const filename = path.basename(new URL(reviewed.tarballUrl).pathname);
    return `  ${JSON.stringify(reviewed.tarballUrl)}) printf 'fixture' > "$pack_dir/${filename}"; printf '[{"filename":"${filename}","integrity":"%s"}]\\n' ${JSON.stringify(reviewed.integrity)} ;;`;
  });
  fs.writeFileSync(
    fixturePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "${1:-}" = "view" ]; then case "${2:-}|${3:-}" in',
      ...metadataCases,
      "  *) exit 1 ;;",
      "esac; exit 0; fi",
      'if [ "${1:-}" = "pack" ]; then pack_dir="${4:-}"; case "${2:-}" in',
      ...packCases,
      "  *) exit 1 ;;",
      "esac; exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}
