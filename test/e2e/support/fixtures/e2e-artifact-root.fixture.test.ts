// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect, test } from "../../fixtures/e2e-test.ts";
import {
  DCODE_BASE_IMAGE_TARGET_ID,
  loadDcodeBaseImagePublicationEvidence,
} from "../../live/dcode-base-image-runtime-evidence.ts";

const FIXTURE_TITLE =
  `${DCODE_BASE_IMAGE_TARGET_ID}: loads base image publication evidence ` +
  "[LangChain Deep Agents Code; GitHub Actions]";

test.runIf(process.env.NEMOCLAW_E2E_ARTIFACT_ROOT_FIXTURE === "stable-target-id")(
  FIXTURE_TITLE,
  {
    meta: {
      e2eArtifactRootId: DCODE_BASE_IMAGE_TARGET_ID,
      e2ePhases: ["load base image publication evidence", "verify stable target ID artifact root"],
    },
  },
  ({ artifacts, progress }) => {
    expect(
      loadDcodeBaseImagePublicationEvidence(
        DCODE_BASE_IMAGE_TARGET_ID,
        artifacts.pathFor("dcode-base-image.json"),
      ),
    ).toBeDefined();
    expect(path.basename(artifacts.rootDir)).toBe(DCODE_BASE_IMAGE_TARGET_ID);
    progress.phase("verify stable target ID artifact root");
  },
);
