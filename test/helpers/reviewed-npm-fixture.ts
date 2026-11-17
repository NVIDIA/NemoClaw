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
    return `  ${JSON.stringify(reviewed.packageSpec)}) printf 'fixture' > "$pack_dir/${filename}"; printf '{"${reviewed.packageSpec}":{"filename":"${filename}","integrity":"%s"}}\\n' ${JSON.stringify(reviewed.integrity)} ;;`;
  });
  fs.writeFileSync(
    fixturePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "${1:-}" = "pack" ]; then test "${NPM_CONFIG_IGNORE_SCRIPTS:-}|${npm_config_ignore_scripts:-}|${NPM_CONFIG_OFFLINE:-}|${npm_config_offline:-}" = "true|true|true|true" || exit 95; fi',
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

/** Keep Docker's cache and native-inspection boundaries active in shell tests. */
export function prepareOfficialPluginBuildFixture(
  command: string,
  directory: string,
  packages: readonly ReviewedPackageFixture[],
): { command: string; env: NodeJS.ProcessEnv } {
  const cache = path.join(directory, "reviewed-cache");
  const bin = path.join(directory, "inspection-bin");
  fs.mkdirSync(cache, { mode: 0o755 });
  fs.mkdirSync(bin);
  const inspections = Object.fromEntries(
    packages.map(({ packageSpec, integrity }) => {
      const name = packageSpec.slice("@openclaw/".length, packageSpec.lastIndexOf("@"));
      const id = name.replace(/-plugin$/, "");
      return [
        id,
        {
          plugin: { id, trustedOfficialInstall: true },
          install: { source: "npm", resolvedSpec: packageSpec, integrity },
        },
      ];
    }),
  );
  fs.writeFileSync(
    path.join(bin, "openclaw"),
    [
      "#!/usr/bin/env node",
      `const inspections = ${JSON.stringify(inspections)};`,
      "if (process.argv[2] !== 'plugins' || process.argv[3] !== 'inspect') process.exit(91);",
      "const result = inspections[process.argv[4]];",
      "if (!result) process.exit(92);",
      "const mutation = process.env.OPTIONAL_PLUGIN_TEST_PROVENANCE;",
      "if (mutation === 'untrusted') result.plugin.trustedOfficialInstall = false;",
      "if (mutation === 'sourcePath' || mutation === 'artifactKind') result.install[mutation] = 'fixture';",
      "if (mutation === 'integrity') result.install.integrity = 'sha512-substituted';",
      "if (mutation === 'spec') result.install.resolvedSpec = '@openclaw/substituted@2099.1.1';",
      "console.log(JSON.stringify(result));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const scripts = path.resolve(import.meta.dirname, "../../scripts/lib");
  return {
    command: command
      .replaceAll("/opt/nemoclaw-managed-messaging-npm-cache", cache)
      .replaceAll("! -user root", `! -user ${process.getuid?.() ?? 0}`)
      .replaceAll(
        "/scripts/lib/reviewed-npm-archive.mts",
        path.join(scripts, "reviewed-npm-archive.mts"),
      )
      .replaceAll(
        "/scripts/lib/verify-openclaw-official-plugin.mts",
        path.join(scripts, "verify-openclaw-official-plugin.mts"),
      ),
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, TMPDIR: directory },
  };
}
