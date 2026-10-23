// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { remediateReviewedOpenClawPluginArchive } from "../../../scripts/lib/openclaw-npm-remediation.mts";
import { packReviewedNpmArchive } from "../../../scripts/lib/reviewed-npm-archive.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const PACKAGE_SPEC = "@openclaw/discord@2026.9.2";
const RUNTIME_TIMEOUT_MS = 180_000;
const PROBE = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = process.argv[1];
const sdkRoot = path.join(pluginRoot, "node_modules/@discord/embedded-app-sdk");
const require = createRequire(path.join(sdkRoot, "package.json"));
assert.equal(require("zod/package.json").version, "4.6.6");
const modules = [
  await import(pathToFileURL(path.join(sdkRoot, "output/index.mjs")).href),
  require(path.join(sdkRoot, "output/index.cjs")),
];
for (const sdk of modules) {
  assert.ok(Object.keys(sdk.Commands).length > 0);
  assert.deepEqual(sdk.Responses.OpenExternalLinkResponse.parse({}), { opened: null });
  assert.deepEqual(sdk.Responses.OpenExternalLinkResponse.parse({ opened: true }), { opened: true });
}
`;

describe.skipIf(process.env.NEMOCLAW_REAL_OPENCLAW_ZOD_HARNESS !== "1")(
  "OpenClaw Discord reviewed Zod runtime",
  () => {
    it(
      "parses SDK defaults through patched Zod in both module formats",
      () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-discord-zod-runtime-"));
        try {
          const config = JSON.parse(
            fs.readFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
          ) as {
            archivePackages: Array<{
              integrity: string;
              label: string;
              packageSpec: string;
              tarballUrl: string;
            }>;
          };
          const reviewed = config.archivePackages.find(
            (candidate) => candidate.packageSpec === PACKAGE_SPEC,
          )!;
          const env = {
            ...process.env,
            NPM_CONFIG_AUDIT: "false",
            NPM_CONFIG_FUND: "false",
            NPM_CONFIG_IGNORE_SCRIPTS: "true",
            NPM_CONFIG_USERCONFIG: "/dev/null",
          };
          const archive = packReviewedNpmArchive({
            env,
            expectedIntegrity: reviewed.integrity,
            label: reviewed.label,
            packageSpec: reviewed.packageSpec,
            tarballUrl: reviewed.tarballUrl,
            tempDirectory: workspace,
          });
          const patched = remediateReviewedOpenClawPluginArchive({
            archivePath: archive.archivePath,
            env,
            packageSpec: reviewed.packageSpec,
            workingDirectory: archive.rootDirectory,
          });
          assert.equal(patched.remediated, true);
          const runtime = path.join(workspace, "runtime");
          const installed = spawnSync(
            "npm",
            [
              "install",
              "--prefix",
              runtime,
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              patched.archivePath,
            ],
            { encoding: "utf8", env, timeout: RUNTIME_TIMEOUT_MS },
          );
          assert.equal(installed.status, 0, installed.stderr || installed.stdout);
          const pluginRoot = path.join(runtime, "node_modules/@openclaw/discord");
          const probed = spawnSync(
            process.execPath,
            ["--input-type=module", "--eval", PROBE, pluginRoot],
            {
              encoding: "utf8",
              env,
              timeout: RUNTIME_TIMEOUT_MS,
            },
          );
          assert.equal(probed.status, 0, probed.stderr || probed.stdout);
        } finally {
          fs.rmSync(workspace, { recursive: true, force: true });
        }
      },
      RUNTIME_TIMEOUT_MS,
    );
  },
);
