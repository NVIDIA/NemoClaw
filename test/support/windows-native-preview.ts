// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readWindowsInstallerWorkflowSources,
  type WorkflowStep,
} from "../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
// The extracted workflow uses Windows paths and the Windows transfer contract.
export const skipPreviewProcesses = process.platform !== "win32";
export const previewSources = () => readWindowsInstallerWorkflowSources(repoRoot);
export function previewStep(steps: WorkflowStep[], name: string) {
  const found = steps.find((step) => step.name === name);
  assert.ok(found, `Missing preview step: ${name}`);
  return found;
}

export function previewFixture(
  extraRunnables: string[] = [],
  agent: "openclaw" | "hermes" = "openclaw",
) {
  const root = mkdtempSync(join(tmpdir(), "windows-native-preview-"));
  const product = join(root, "finished-windows-product-transfer");
  const packageDirectory = join(product, "package");
  const helperDirectory = join(root, "candidate/scripts/checks");
  const transferScript = join(helperDirectory, "windows-native-transfer.ps1");
  const label = join(root, `unqualified-${agent}-preview.json`);
  const revision = "a".repeat(40);
  const setup = "NemoClawSetup-0.1.10-windows-arm64.exe";
  const cleanup = () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { force: true, recursive: true });
  };
  try {
    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(helperDirectory, { recursive: true });
    writeFileSync(
      transferScript,
      readFileSync(join(repoRoot, "scripts/checks/windows-native-transfer.ps1")),
    );
    const files = ["NemoClaw-0.1.10-windows-arm64.msi", setup, ...extraRunnables].map((file) => {
      const bytes = Buffer.from(`inert-preview-fixture-${file}`);
      writeFileSync(join(packageDirectory, file), bytes);
      return {
        file,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    const receipt = {
      sourceRevision: revision,
      status: "candidate-built-for-installed-qualification",
      files,
    };
    const receiptPath = join(packageDirectory, "immutable-package-build.json");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const create = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        transferScript,
        "-Mode",
        "Create",
        "-Root",
        product,
        "-Kind",
        "finished-installer",
        "-SourceRevision",
        revision,
        "-Agent",
        agent,
        "-RunId",
        "123",
        "-RunAttempt",
        "1",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(create.status, 0, create.stdout + create.stderr);
    const manifest = create.stdout.trim();
    const script = join(root, "preview.ps1");
    writeFileSync(
      script,
      previewStep(
        previewSources().workflow.jobs["windows-finished-installer"].steps!,
        `Verify and label the unqualified ${agent === "hermes" ? "Hermes" : "OpenClaw"} preview`,
      ).run!,
    );
    return {
      cleanup,
      label,
      revision,
      manifest,
      receipt,
      receiptPath,
      installer: files[1],
      msi: files[0],
      setupPath: join(packageDirectory, setup),
      run: (overrides: Record<string, string> = {}) =>
        spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", script], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            GITHUB_WORKSPACE: root,
            PRODUCT_VERSION: "0.1.10",
            CANDIDATE_SHA: revision,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
            INSTALLER_MANIFEST: manifest,
            ...overrides,
          },
        }),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
