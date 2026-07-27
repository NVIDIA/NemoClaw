// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";
import { removeLegacyCredentialsFile } from "../src/lib/credentials/store.js";
import { hydrateCredentialEnv } from "../src/lib/onboard/credential-env.js";
import { createDirectSetupInferenceHarness } from "./helpers/onboard-split-context";
import { withProcessEnv } from "./support/setup-inference-test-harness.js";

describe("legacy credential reconciliation", () => {
  it("migrates only allowlisted credentials through mocked gateway registration (#7617)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-cred-"));
    const legacyDir = path.join(tmpDir, ".nemoclaw");
    const legacyFile = path.join(legacyDir, "credentials.json");
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        OPENAI_API_KEY: "sk-TEST-NOT-A-REAL-STORED-KEY",
        OPENSHELL_GATEWAY: "tampered-gateway",
        NODE_OPTIONS: "--require=/tmp/tampered.js",
      }),
      { mode: 0o600 },
    );
    try {
      await withProcessEnv(
        {
          HOME: tmpDir,
          OPENAI_API_KEY: undefined,
          OPENSHELL_GATEWAY: "trusted-gateway",
          NODE_OPTIONS: "--enable-source-maps",
        },
        async () => {
          const harness = createDirectSetupInferenceHarness({
            runOpenshell: (args) =>
              args.slice(0, 2).join(" ") === "provider get"
                ? { status: 0, stdout: "", stderr: "" }
                : undefined,
            overrides: { hydrateCredentialEnv },
          });

          await harness.setupInference(
            "test-box",
            "gpt-5.4",
            "openai-api",
            "https://api.openai.com/v1",
            "OPENAI_API_KEY",
          );

          assert.equal(process.env.OPENAI_API_KEY, "sk-TEST-NOT-A-REAL-STORED-KEY");
          assert.equal(process.env.OPENSHELL_GATEWAY, "trusted-gateway");
          assert.equal(process.env.NODE_OPTIONS, "--enable-source-maps");
          assert.equal(
            fs.existsSync(legacyFile),
            true,
            "legacy credentials.json must survive the staging-only hydrate path",
          );
          const providerUpdate = harness.commands.find((entry) =>
            entry.command.includes("provider update -g nemoclaw openai-api"),
          );
          assert.ok(providerUpdate, "expected provider update command");
          assert.equal(providerUpdate.env?.OPENAI_API_KEY, "sk-TEST-NOT-A-REAL-STORED-KEY");
          assert.doesNotMatch(providerUpdate.command, /sk-TEST-NOT-A-REAL-STORED-KEY/);
          assert.doesNotMatch(providerUpdate.command, /tampered-gateway|tampered\.js/);
          assert.notEqual(providerUpdate.env?.OPENSHELL_GATEWAY, "tampered-gateway");
          assert.notEqual(providerUpdate.env?.NODE_OPTIONS, "--require=/tmp/tampered.js");

          removeLegacyCredentialsFile();
          assert.equal(
            fs.existsSync(legacyFile),
            false,
            "legacy credentials.json is removed only after mocked gateway registration succeeds",
          );
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
