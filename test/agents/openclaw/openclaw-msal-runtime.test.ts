// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { remediateInstalledOfficialOpenClawPlugin } from "../../../scripts/lib/openclaw-npm-remediation.mts";
import { packReviewedNpmArchive } from "../../../scripts/lib/reviewed-npm-archive.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const PACKAGE_SPEC = "@openclaw/msteams@2026.9.2";
const RUNTIME_TIMEOUT_MS = 180_000;
const PROBE = String.raw`
const assert = require("node:assert/strict");
const path = require("node:path");
const root = process.argv[1];
const { TokenManager } = require(path.join(root, "@microsoft/teams.apps/dist/token-manager.js"));
const { ConsoleLogger } = require(path.join(root, "@microsoft/teams.common"));
const { ClientSecretCredential, ManagedIdentityCredential } = require(path.join(root, "@azure/identity"));
const logger = new ConsoleLogger("msal-probe");
const clientId = "00000000-0000-0000-0000-000000000001";
const tenantId = "00000000-0000-0000-0000-000000000002";
const secret = new TokenManager({ clientId, tenantId, clientSecret: "dummy" }, logger);
assert.equal(typeof secret.getConfidentialClient(secret.credentials, tenantId).acquireTokenByClientCredential, "function");
const identity = new TokenManager({ clientId, tenantId }, logger);
assert.equal(typeof identity.getManagedIdentityClient(identity.credentials).acquireToken, "function");
new ClientSecretCredential(tenantId, clientId, "dummy");
new ManagedIdentityCredential({ clientId });
`;

describe.skipIf(process.env.NEMOCLAW_REAL_OPENCLAW_MSAL_HARNESS !== "1")(
  "OpenClaw MSteams reviewed MSAL runtime",
  () => {
    it(
      "keeps Teams token manager and Azure identity constructors working after the official install update",
      () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-msal-runtime-"));
        try {
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
            `openclaw-msteams-${createHash("sha256").update("@openclaw/msteams").digest("hex").slice(0, 10)}`,
          );
          const install = spawnSync(
            "npm",
            [
              "install",
              "--prefix",
              project,
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--legacy-peer-deps",
              archive.archivePath,
            ],
            { encoding: "utf8", env, timeout: RUNTIME_TIMEOUT_MS },
          );
          assert.equal(install.status, 0, install.stderr || install.stdout);
          const warmPackage = (packageSpec: string) => {
            const warm = spawnSync(
              "npm",
              ["pack", packageSpec, "--pack-destination", workspace, "--ignore-scripts", "--json"],
              { encoding: "utf8", env, timeout: RUNTIME_TIMEOUT_MS },
            );
            assert.equal(warm.status, 0, warm.stderr || warm.stdout);
          };
          warmPackage("@azure/msal-node@7.1.0");
          warmPackage("@azure/msal-common@16.14.2");
          warmPackage("zod@4.6.6");
          const packageDirectory = path.join(project, "node_modules/@openclaw/msteams");
          remediateInstalledOfficialOpenClawPlugin({
            archivePath: archive.archivePath,
            env,
            packageSpec: PACKAGE_SPEC,
            packageDirectory,
            trustedStateRoot: stateRoot,
            workingDirectory: archive.rootDirectory,
          });
          const modules = path.join(project, "node_modules");
          assert.equal(
            JSON.parse(fs.readFileSync(path.join(modules, "@azure/msal-node/package.json"), "utf8"))
              .version,
            "7.1.0",
          );
          assert.equal(
            JSON.parse(fs.readFileSync(path.join(modules, "zod/package.json"), "utf8")).version,
            "4.6.6",
          );
          const probe = spawnSync(process.execPath, ["--eval", PROBE, modules], {
            encoding: "utf8",
            env,
            timeout: RUNTIME_TIMEOUT_MS,
          });
          assert.equal(probe.status, 0, probe.stderr || probe.stdout);
        } finally {
          fs.rmSync(workspace, { recursive: true, force: true });
        }
      },
      RUNTIME_TIMEOUT_MS,
    );
  },
);
