// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readReviewedOpenShellSdkInstallScript,
  validateReviewedOpenShellSdkInstallAction,
} from "../../../tools/e2e/reviewed-openshell-sdk-install-workflow-boundary.mts";
import { parseNpmPackArchives } from "./openshell-sdk-pack-archives.ts";

describe("reviewed OpenShell SDK E2E boundary", () => {
  it.for([
    {
      name: "npm 11 array metadata",
      output: JSON.stringify([
        { filename: "fixture-transport-1.0.0.tgz", name: "fixture-transport", version: "1.0.0" },
      ]),
    },
    {
      name: "npm 12 keyed metadata",
      output: JSON.stringify({
        "fixture-transport@1.0.0": {
          filename: "fixture-transport-1.0.0.tgz",
          name: "fixture-transport",
          version: "1.0.0",
        },
      }),
    },
  ])("reads $name from npm pack", ({ output }) => {
    expect(parseNpmPackArchives(output)).toEqual([
      { filename: "fixture-transport-1.0.0.tgz", name: "fixture-transport", version: "1.0.0" },
    ]);
  });

  it("rejects npm pack metadata without an archive filename", () => {
    expect(() =>
      parseNpmPackArchives(JSON.stringify([{ name: "fixture-transport", version: "1.0.0" }])),
    ).toThrow("npm pack --json returned invalid package metadata");
  });

  it("keeps the E2E action as a thin trusted-installer adapter", () => {
    expect(readReviewedOpenShellSdkInstallScript()).toContain(
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh" none artifact',
    );
  });

  it("rejects changes to the immutable action content", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-action-"));
    const actionPath = path.join(directory, "action.yaml");
    try {
      fs.writeFileSync(
        actionPath,
        fs
          .readFileSync(".github/actions/install-reviewed-openshell-sdk/action.yaml", "utf8")
          .replace("none artifact", "none registry"),
      );
      expect(validateReviewedOpenShellSdkInstallAction(actionPath)).toContain(
        "reviewed OpenShell SDK install action content must match its immutable commit pin",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
