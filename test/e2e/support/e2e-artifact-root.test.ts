// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { slugifyArtifactName } from "../fixtures/artifacts.ts";
import { DCODE_BASE_IMAGE, DCODE_BASE_IMAGE_ENV } from "../fixtures/dcode-base-image.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { DCODE_BASE_IMAGE_TARGET_ID } from "../live/dcode-base-image-runtime-evidence.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE = "test/e2e/support/fixtures/e2e-artifact-root.fixture.test.ts";
const CANDIDATE_SHA = "d".repeat(40);
const SOURCE_REVISION = "e".repeat(40);
const INDEX_DIGEST = `sha256:${"a".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"b".repeat(64)}`;
const ARM64_DIGEST = `sha256:${"c".repeat(64)}`;
const AMD64_REFERENCE = `${DCODE_BASE_IMAGE}@${AMD64_DIGEST}`;
const FIXTURE_TITLE =
  `${DCODE_BASE_IMAGE_TARGET_ID}: loads base image publication evidence ` +
  "[LangChain Deep Agents Code; GitHub Actions]";

function publicationEvidence() {
  return {
    contractVersion: 1,
    candidateSha: CANDIDATE_SHA,
    base: {
      agent: "langchain-deepagents-code",
      contractVersion: 1,
      digest: INDEX_DIGEST,
      image: DCODE_BASE_IMAGE,
      platformDigests: {
        "linux/amd64": AMD64_DIGEST,
        "linux/arm64": ARM64_DIGEST,
      },
      platformReferences: {
        "linux/amd64": AMD64_REFERENCE,
        "linux/arm64": `${DCODE_BASE_IMAGE}@${ARM64_DIGEST}`,
      },
      platforms: ["linux/amd64", "linux/arm64"],
      reference: `${DCODE_BASE_IMAGE}@${INDEX_DIGEST}`,
      run: { attempt: 1, id: 32204372503 },
      sourceRevision: SOURCE_REVISION,
    },
  };
}

function writePublicationEvidence(root: string): void {
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  fs.writeFileSync(
    path.join(root, "dcode-base-image.json"),
    `${JSON.stringify(publicationEvidence(), null, 2)}\n`,
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
        [DCODE_BASE_IMAGE_ENV]: AMD64_REFERENCE,
        E2E_ARTIFACT_DIR: artifactRoot,
        E2E_TARGET_ID: DCODE_BASE_IMAGE_TARGET_ID,
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: CANDIDATE_SHA,
        NEMOCLAW_E2E_ARTIFACT_ROOT_FIXTURE: "stable-target-id",
        NEMOCLAW_E2E_EXPECTED_SHA: CANDIDATE_SHA,
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
    try {
      writePublicationEvidence(targetRoot);
      const result = runArtifactRootFixture(artifactRoot);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fs.readdirSync(artifactRoot)).toEqual([DCODE_BASE_IMAGE_TARGET_ID]);
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

it(
  "does not read LangChain Deep Agents Code base image publication evidence from an artifact root derived from the semantic test title",
  testTimeoutOptions(30_000),
  () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-artifact-root-"));
    const semanticRoot = path.join(artifactRoot, slugifyArtifactName(FIXTURE_TITLE));
    try {
      writePublicationEvidence(semanticRoot);
      const result = runArtifactRootFixture(artifactRoot);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain(
        "Deep Agents Code GitHub Actions run is missing published base evidence",
      );
      expect(fs.existsSync(path.join(semanticRoot, "dcode-base-image.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(artifactRoot, DCODE_BASE_IMAGE_TARGET_ID, "dcode-base-image.json")),
      ).toBe(false);
    } finally {
      fs.rmSync(artifactRoot, { force: true, recursive: true });
    }
  },
);
