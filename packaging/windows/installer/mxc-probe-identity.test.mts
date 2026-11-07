// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "Setup compilation requires the admitted probe pin and retains the legacy preview pin",
  {
    skip: process.platform !== "win32",
    timeout: 60_000,
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-probe-build-"));
    const project = fileURLToPath(
      new URL("../bootstrapper/NemoClaw.Bootstrapper.csproj", import.meta.url),
    );
    const availability = path.join(root, "availability.json");
    // This target checks input presence only; availability parsing has separate controls.
    fs.writeFileSync(availability, "{}");
    const invoke = (immutable: boolean, pin?: string) => {
      const result = spawnSync(
        process.env.NEMOCLAW_TEST_DOTNET ?? "dotnet",
        [
          "msbuild",
          project,
          "-nologo",
          "-target:ValidateImmutableRuntimePresentation",
          "-getItem:AssemblyMetadata",
          "-p:ProductVersion=0.1.26",
          `-p:ImmutableRuntimePackage=${immutable}`,
          `-p:ImmutableRuntimeAvailabilityFile=${availability}`,
          ...(pin === undefined ? [] : [`-p:MxcProbeSha256=${pin}`]),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 },
      );
      assert.ifError(result.error);
      return result;
    };
    try {
      for (const pin of [undefined, "", "0".repeat(63), "G".repeat(64)]) {
        const rejected = invoke(true, pin);
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stdout + rejected.stderr, /exact admitted MXC probe SHA-256/u);
      }
      for (const [immutable, pin, expected] of [
        [true, "a".repeat(64), "a".repeat(64)],
        [false, undefined, "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503"],
      ] as const) {
        const accepted = invoke(immutable, pin);
        assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
        const metadata = JSON.parse(accepted.stdout).Items.AssemblyMetadata as Array<{
          Identity: string;
          Value: string;
        }>;
        assert.deepEqual(
          metadata
            .filter((item) => item.Identity === "NemoClaw.MxcProbeSha256")
            .map((item) => item.Value),
          [expected],
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Setup probe identity follows the admitted source build and rejects stale or changed inputs",
  {
    skip: process.platform !== "win32",
    timeout: 60_000,
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-probe-identity-"));
    const script = fileURLToPath(new URL("./build-immutable-package.ps1", import.meta.url));
    const bytes = Buffer.from("non-executable same-run MXC probe fixture");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const source = "a".repeat(40);
    const row = { file: "wxc-exec.exe", bytes: bytes.length, sha256 };
    const receipt = {
      schemaVersion: 1,
      classification: "finished-native-host-components",
      sourceRevision: source,
      mxcSourceRevision: "b".repeat(40),
      mxcBuild: {
        schemaVersion: 1,
        classification: "ci-built-mxc-host-binaries",
        requestedSourceRevision: source,
        sourceUnchanged: true,
        currentPackageQualification: false,
        workflowRunId: "1234",
        workflowRunAttempt: "2",
        mxcRevision: "b".repeat(40),
        rustTarget: "aarch64-pc-windows-msvc",
        files: [row],
      },
      files: [{ ...row, file: "mxc/wxc-exec.exe" }],
    };
    const command = `
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:NEMOCLAW_TEST_PROBE_SOURCE, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Package builder syntax is invalid.' }
    $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-PackagedMxcProbeSha256' }, $false))
    if ($definitions.Count -ne 1) { throw 'The package probe identity owner is missing or ambiguous.' }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
    Get-PackagedMxcProbeSha256 $env:NEMOCLAW_TEST_PROBE_ROOT $env:NEMOCLAW_TEST_PROBE_ROOT '${source}' '1234' '2'
  `;
    const invoke = () => {
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(command, "utf16le").toString("base64"),
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          env: {
            ...process.env,
            NEMOCLAW_TEST_PROBE_SOURCE: script,
            NEMOCLAW_TEST_PROBE_ROOT: root,
          },
        },
      );
      assert.ifError(result.error);
      return result;
    };
    const receiptPath = path.join(root, "runtime-payload-receipt.json");
    const probePath = path.join(root, "mxc", "wxc-exec.exe");
    const writeReceipt = (value: unknown) => fs.writeFileSync(receiptPath, JSON.stringify(value));
    try {
      fs.mkdirSync(path.dirname(probePath));
      fs.writeFileSync(probePath, bytes);
      writeReceipt(receipt);
      const accepted = invoke();
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout.trim(), sha256);
      const mutations: Array<(value: typeof receipt) => void> = [
        (value) => {
          value.sourceRevision = "c".repeat(40);
        },
        (value) => {
          value.mxcBuild.requestedSourceRevision = "c".repeat(40);
        },
        (value) => {
          value.mxcBuild.workflowRunId = "1235";
        },
        (value) => {
          value.mxcBuild.workflowRunAttempt = "3";
        },
        (value) => {
          value.mxcBuild.sourceUnchanged = false;
        },
        (value) => {
          value.mxcBuild.currentPackageQualification = true;
        },
        (value) => {
          value.mxcBuild.rustTarget = "x86_64-pc-windows-msvc";
        },
        (value) => {
          value.mxcBuild.mxcRevision = "c".repeat(40);
        },
        (value) => {
          value.mxcBuild.files = [];
        },
        (value) => {
          value.mxcBuild.files.push({ ...row });
        },
        (value) => {
          value.files.push({ ...value.files[0]! });
        },
        (value) => {
          value.files[0]!.sha256 = "0".repeat(64);
        },
        (value) => {
          value.mxcBuild.files[0]!.bytes++;
        },
        (value) => {
          value.mxcBuild.files[0]!.sha256 = sha256.toUpperCase();
        },
      ];
      for (const [index, mutate] of mutations.entries()) {
        const changed = structuredClone(receipt);
        mutate(changed);
        writeReceipt(changed);
        const rejected = invoke();
        assert.notEqual(rejected.status, 0, `receipt mutation ${index} was admitted`);
        assert.equal(rejected.stdout.trim(), "");
        assert.deepEqual(fs.readFileSync(probePath), bytes);
      }
      writeReceipt(receipt);
      fs.writeFileSync(probePath, Buffer.alloc(bytes.length));
      assert.notEqual(invoke().status, 0, "same-size substituted bytes were admitted");
      fs.unlinkSync(probePath);
      assert.notEqual(invoke().status, 0, "a missing probe was admitted");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
