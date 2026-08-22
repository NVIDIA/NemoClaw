// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { slugifyArtifactName } from "../fixtures/artifacts.ts";
import { DCODE_BASE_IMAGE_ENV } from "../fixtures/dcode-base-image.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { DCODE_BASE_IMAGE_TARGET_ID } from "../live/dcode-base-image-runtime-evidence.ts";
import {
  DCODE_BASE_IMAGE_AMD64_REFERENCE,
  DCODE_BASE_IMAGE_CANDIDATE_SHA,
  dcodeBaseImagePublicationEvidence,
} from "./fixtures/dcode-base-image-publication-evidence.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE = "test/e2e/support/fixtures/e2e-artifact-root.fixture.test.ts";
const FIXTURE_TITLE =
  `${DCODE_BASE_IMAGE_TARGET_ID}: loads base image publication evidence ` +
  "[LangChain Deep Agents Code; GitHub Actions]";

function writePublicationEvidence(root: string): void {
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  fs.writeFileSync(
    path.join(root, "dcode-base-image.json"),
    `${JSON.stringify(dcodeBaseImagePublicationEvidence({ runId: 32204372503 }), null, 2)}\n`,
    "utf8",
  );
}

function runArtifactRootFixture(artifactRoot: string) {
  return spawnSync(
    process.execPath,
    [VITEST, "run", "--project", "e2e-support", FIXTURE, "--reporter=default"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 20_000,
      env: {
        ...process.env,
        [DCODE_BASE_IMAGE_ENV]: DCODE_BASE_IMAGE_AMD64_REFERENCE,
        E2E_ARTIFACT_DIR: artifactRoot,
        E2E_TARGET_ID: DCODE_BASE_IMAGE_TARGET_ID,
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: DCODE_BASE_IMAGE_CANDIDATE_SHA,
        NEMOCLAW_E2E_ARTIFACT_ROOT_FIXTURE: "stable-target-id",
        NEMOCLAW_E2E_EXPECTED_SHA: DCODE_BASE_IMAGE_CANDIDATE_SHA,
        NEMOCLAW_RUN_LIVE_E2E: "0",
      },
    },
  );
}

it(
  "loads LangChain Deep Agents Code base image publication evidence from the stable target ID artifact root",
  testTimeoutOptions(30_000),
  () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-artifact-root-"));
    const targetRoot = path.join(artifactRoot, DCODE_BASE_IMAGE_TARGET_ID);
    const semanticRoot = path.join(artifactRoot, slugifyArtifactName(FIXTURE_TITLE));
    try {
      expect(semanticRoot).not.toBe(targetRoot);
      writePublicationEvidence(targetRoot);
      const result = runArtifactRootFixture(artifactRoot);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readdirSync(artifactRoot)).toEqual([DCODE_BASE_IMAGE_TARGET_ID]);
      expect(fs.existsSync(semanticRoot)).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(targetRoot, "artifact-summary.json"), "utf8")),
      ).toMatchObject({
        test: FIXTURE_TITLE,
      });
    } finally {
      fs.rmSync(artifactRoot, { force: true, recursive: true });
    }
  },
);
