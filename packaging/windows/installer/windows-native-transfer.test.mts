// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test(
  "installer transfer retains the sealed application and rejects nested tampering or stale identity",
  { skip: process.platform !== "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nested-transfer-"));
    const application = path.join(root, "compiled-application");
    const controller = path.join(application, "application", "node", "node.exe");
    const script = fileURLToPath(
      new URL("../../../scripts/checks/windows-native-transfer.ps1", import.meta.url),
    );
    const revision = "a".repeat(40);
    const run = (
      mode: string,
      directory: string,
      kind: string,
      manifest?: string,
      attempt = "1",
    ) => {
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          script,
          "-Mode",
          mode,
          "-Root",
          directory,
          "-Kind",
          kind,
          "-SourceRevision",
          revision,
          "-Agent",
          "openclaw",
          "-RunId",
          "123",
          "-RunAttempt",
          attempt,
          ...(manifest ? ["-ExpectedManifestSha256", manifest] : []),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 30_000 },
      );
      assert.ifError(result.error);
      return result;
    };
    try {
      fs.mkdirSync(path.dirname(controller), { recursive: true });
      fs.mkdirSync(path.join(root, "package"));
      fs.writeFileSync(controller, "non-executable controller fixture");
      fs.writeFileSync(path.join(root, "package", "fixture.msi"), "non-executable MSI fixture");
      const app = run("Create", application, "compiled-application");
      assert.equal(app.status, 0, app.stderr);
      const appHash = app.stdout.trim();
      const product = run("Create", root, "finished-installer");
      assert.equal(product.status, 0, product.stderr);
      const productHash = product.stdout.trim();
      assert.equal(run("Verify", root, "finished-installer", productHash).status, 0);
      assert.equal(run("Verify", application, "compiled-application", appHash).status, 0);
      assert.notEqual(run("Verify", application, "compiled-application", appHash, "2").status, 0);
      fs.appendFileSync(controller, "substitution");
      assert.notEqual(run("Verify", root, "finished-installer", productHash).status, 0);
      assert.notEqual(run("Verify", application, "compiled-application", appHash).status, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
