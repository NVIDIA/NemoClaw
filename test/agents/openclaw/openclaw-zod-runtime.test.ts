// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  hashPackageTree,
  remediateInstalledOfficialOpenClawPlugin,
  remediateReviewedOpenClawPluginArchive,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";
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

function verifyNativeLauncherBoundary(
  request: Parameters<typeof remediateInstalledOfficialOpenClawPlugin>[0],
  pluginRoot: string,
  workspace: string,
): void {
  const sdk = path.join(pluginRoot, "node_modules/@discord/embedded-app-sdk");
  const launcher = path.join(sdk, "node_modules/.bin/uuid");
  const target = "../uuid/dist-node/bin/uuid";
  const uuid = path.join(sdk, "node_modules/uuid");
  const program = path.join(uuid, "dist-node/bin/uuid");
  const metadata = path.join(uuid, "package.json");
  const programBytes = fs.readFileSync(program);
  const metadataBytes = fs.readFileSync(metadata);
  const extraLink = path.join(sdk, "extra-link.cjs");
  const hardLink = path.join(workspace, "sdk-output-hardlink");
  const snapshot = () => ({
    output: hashPackageTree(path.join(sdk, "output")),
    zod: hashPackageTree(path.join(pluginRoot, "node_modules/zod")),
    manifest: fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"),
  });
  const replaceLink = (destination: string) => {
    fs.unlinkSync(launcher);
    fs.symlinkSync(destination, launcher);
  };
  const reject = (alter: () => void, restore: () => void) => {
    const before = snapshot();
    alter();
    try {
      assert.throws(() => remediateInstalledOfficialOpenClawPlugin(request));
      assert.deepEqual(snapshot(), before);
    } finally {
      restore();
    }
  };

  assert.equal(fs.readlinkSync(launcher), target);
  reject(
    () => replaceLink("../uuid/dist-node/bin/../bin/uuid"),
    () => replaceLink(target),
  );
  reject(
    () => replaceLink(program),
    () => replaceLink(target),
  );
  reject(
    () => fs.symlinkSync("output/index.cjs", extraLink),
    () => fs.unlinkSync(extraLink),
  );
  reject(
    () => fs.linkSync(path.join(sdk, "output/index.cjs"), hardLink),
    () => fs.unlinkSync(hardLink),
  );
  reject(
    () => fs.appendFileSync(program, "\n// unreviewed launcher\n"),
    () => fs.writeFileSync(program, programBytes),
  );
  reject(
    () =>
      fs.writeFileSync(
        metadata,
        JSON.stringify({ ...JSON.parse(metadataBytes.toString()), version: "14.0.3" }),
      ),
    () => fs.writeFileSync(metadata, metadataBytes),
  );
  assert.equal(fs.readlinkSync(launcher), target);
}

describe.skipIf(process.env.NEMOCLAW_REAL_OPENCLAW_ZOD_HARNESS !== "1")(
  "OpenClaw Discord reviewed Zod runtime",
  () => {
    it.each(["repacked archive", "official install"])(
      "parses SDK defaults through patched Zod in both module formats for the %s",
      (source) => {
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
          const patched =
            source === "repacked archive"
              ? remediateReviewedOpenClawPluginArchive({
                  archivePath: archive.archivePath,
                  env,
                  packageSpec: reviewed.packageSpec,
                  workingDirectory: archive.rootDirectory,
                })
              : undefined;
          const stateRoot = path.join(workspace, "state");
          const runtime =
            source === "official install"
              ? path.join(
                  stateRoot,
                  "npm/projects",
                  `openclaw-discord-${createHash("sha256").update("@openclaw/discord").digest("hex").slice(0, 10)}`,
                )
              : path.join(workspace, "runtime");
          const installed = spawnSync(
            "npm",
            [
              "install",
              "--prefix",
              runtime,
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              patched?.archivePath ?? archive.archivePath,
            ],
            { encoding: "utf8", env, timeout: RUNTIME_TIMEOUT_MS },
          );
          assert.equal(installed.status, 0, installed.stderr || installed.stdout);
          const pluginRoot = path.join(runtime, "node_modules/@openclaw/discord");
          const remediationRequest = {
            archivePath: archive.archivePath,
            env,
            packageSpec: PACKAGE_SPEC,
            packageDirectory: pluginRoot,
            trustedStateRoot: stateRoot,
            workingDirectory: archive.rootDirectory,
          };
          const afterInstall =
            source === "official install"
              ? () => {
                  remediateInstalledOfficialOpenClawPlugin(remediationRequest);
                  assert.equal(
                    JSON.parse(
                      fs.readFileSync(
                        path.join(pluginRoot, "node_modules/undici/package.json"),
                        "utf8",
                      ),
                    ).version,
                    "8.12.2",
                  );
                  verifyNativeLauncherBoundary(remediationRequest, pluginRoot, workspace);
                }
              : () => undefined;
          afterInstall();
          afterInstall();
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

    it(
      "resumes an official Discord install after the final Zod copy fails",
      () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-discord-zod-retry-"));
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
          const stateRoot = path.join(workspace, "state");
          const project = path.join(
            stateRoot,
            "npm/projects",
            `openclaw-discord-${createHash("sha256").update("@openclaw/discord").digest("hex").slice(0, 10)}`,
          );
          const installed = spawnSync(
            "npm",
            [
              "install",
              "--prefix",
              project,
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              archive.archivePath,
            ],
            { encoding: "utf8", env, timeout: RUNTIME_TIMEOUT_MS },
          );
          assert.equal(installed.status, 0, installed.stderr || installed.stdout);
          const pluginRoot = path.join(project, "node_modules/@openclaw/discord");
          const retryProbe = String.raw`
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fs = createRequire(import.meta.url)("node:fs");
const originalRename = fs.renameSync;
const pluginRoot = process.argv[1];
const destination = path.join(pluginRoot, "node_modules/zod");
let failed = false;
fs.renameSync = (source, target) => {
  if (!failed && path.basename(source) === "replacement" && path.resolve(target) === destination) {
    failed = true;
    throw Object.assign(new Error("simulated final Zod copy failure"), { code: "EIO" });
  }
  return originalRename(source, target);
};
syncBuiltinESMExports();
const { remediateInstalledOfficialOpenClawPlugin } = await import(pathToFileURL(process.argv[2]).href);
const request = {
  archivePath: process.argv[3],
  env: process.env,
  packageSpec: "@openclaw/discord@2026.9.2",
  packageDirectory: pluginRoot,
  trustedStateRoot: process.argv[4],
  workingDirectory: process.argv[5],
};
assert.throws(() => remediateInstalledOfficialOpenClawPlugin(request));
assert.equal(failed, true);
fs.renameSync = originalRename;
syncBuiltinESMExports();
remediateInstalledOfficialOpenClawPlugin(request);
assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8")).version, "4.6.6");
`;
          const retried = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "--eval",
              retryProbe,
              pluginRoot,
              path.join(REPO_ROOT, "scripts/lib/openclaw-npm-remediation.mts"),
              archive.archivePath,
              stateRoot,
              archive.rootDirectory,
            ],
            { encoding: "utf8", env, timeout: RUNTIME_TIMEOUT_MS },
          );
          assert.equal(retried.status, 0, retried.stderr || retried.stdout);
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
