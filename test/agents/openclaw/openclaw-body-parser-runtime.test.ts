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
  remediateInstalledOfficialOpenClawPlugin,
  remediateReviewedOpenClawPluginArchive,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";
import { packReviewedNpmArchive } from "../../../scripts/lib/reviewed-npm-archive.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const RUNTIME_TIMEOUT_MS = 180_000;
const PROBE = String.raw`
const assert = require("node:assert/strict");
const http = require("node:http");
const { createRequire } = require("node:module");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

const boltRequire = createRequire(path.join(process.argv[1], "node_modules/@slack/bolt/package.json"));
assert.equal(boltRequire("body-parser/package.json").version, "2.4.0");
assert.equal(boltRequire("qs/package.json").version, "6.16.1");
const parse = boltRequire("body-parser").json();
const server = http.createServer((request, response) => parse(request, response, (error) => {
  response.statusCode = error ? 400 : 200;
  response.end(error ? "rejected" : JSON.stringify(request.body));
}));
const send = (bytes) => new Promise((resolve, reject) => {
  const request = http.request({
    hostname: "127.0.0.1",
    port: server.address().port,
    method: "POST",
    headers: {
      "content-encoding": "gzip",
      "content-length": bytes.length,
      "content-type": "application/json",
    },
  }, (response) => {
    response.resume();
    response.on("end", () => resolve(response.statusCode));
  });
  request.on("error", reject);
  request.end(bytes);
});
(async () => {
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const valid = gzipSync(Buffer.from('{"ok":true}'));
  assert.equal(await send(valid), 200);
  await send(Buffer.concat([valid, Buffer.from([0xff, 0x00, 0xff])]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await send(valid), 200);
} finally {
  server.close();
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

type HarnessContext = {
  archive: ReturnType<typeof packReviewedNpmArchive>;
  env: NodeJS.ProcessEnv;
  packageSpec: string;
  workspace: string;
};

type HarnessPlan = {
  afterInstall: (pluginRoot: string) => void;
  installArchive: string;
  project: string;
};

function runSlackParserHarness(
  version: "2026.9.2" | "2026.9.5",
  prepare: (context: HarnessContext) => HarnessPlan,
): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-parser-runtime-"));
  try {
    const packageSpec = `@openclaw/slack@${version}`;
    const config = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "test/fixtures/openclaw/reviewed-legacy-plugin-archives.json"),
        "utf8",
      ),
    ) as {
      archivePackages: Array<{
        integrity: string;
        label: string;
        packageSpec: string;
        tarballUrl: string;
      }>;
    };
    const reviewed = config.archivePackages.find(
      (candidate) => candidate.packageSpec === packageSpec,
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
      packageSpec,
      tarballUrl: reviewed.tarballUrl,
      tempDirectory: workspace,
    });
    const plan = prepare({ archive, env, packageSpec, workspace });
    const installed = spawnSync(
      "npm",
      [
        "install",
        "--prefix",
        plan.project,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        plan.installArchive,
      ],
      { encoding: "utf8", env, timeout: RUNTIME_TIMEOUT_MS },
    );
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const pluginRoot = path.join(plan.project, "node_modules/@openclaw/slack");
    plan.afterInstall(pluginRoot);
    plan.afterInstall(pluginRoot);
    const probed = spawnSync(process.execPath, ["--eval", PROBE, pluginRoot], {
      encoding: "utf8",
      env,
      timeout: RUNTIME_TIMEOUT_MS,
    });
    assert.equal(probed.status, 0, probed.stderr || probed.stdout);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.NEMOCLAW_REAL_OPENCLAW_BODY_PARSER_HARNESS !== "1")(
  "OpenClaw Slack reviewed body-parser runtime",
  () => {
    it(
      "keeps the official 2026.9.2 plugin process alive after repeated remediation and malformed compressed input",
      () =>
        runSlackParserHarness("2026.9.2", ({ archive, env, packageSpec, workspace }) => {
          const stateRoot = path.join(workspace, "state");
          return {
            installArchive: archive.archivePath,
            project: path.join(
              stateRoot,
              "npm/projects",
              `openclaw-slack-${createHash("sha256").update("@openclaw/slack").digest("hex").slice(0, 10)}`,
            ),
            afterInstall: (pluginRoot) =>
              remediateInstalledOfficialOpenClawPlugin({
                archivePath: archive.archivePath,
                env,
                packageSpec,
                packageDirectory: pluginRoot,
                trustedStateRoot: stateRoot,
                workingDirectory: archive.rootDirectory,
              }),
          };
        }),
      RUNTIME_TIMEOUT_MS,
    );
    it(
      "keeps the repacked 2026.9.5 plugin process alive after malformed compressed input",
      () =>
        runSlackParserHarness("2026.9.5", ({ archive, env, packageSpec, workspace }) => ({
          installArchive: remediateReviewedOpenClawPluginArchive({
            archivePath: archive.archivePath,
            env,
            packageSpec,
            workingDirectory: archive.rootDirectory,
          }).archivePath,
          project: path.join(workspace, "archive-project"),
          afterInstall: () => undefined,
        })),
      RUNTIME_TIMEOUT_MS,
    );
  },
);
