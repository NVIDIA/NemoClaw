// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { V1ALPHA1_RUNTIME_DEFAULTS_REVISION } from "../../src/lib/domain/config/v1alpha1-runtime-defaults";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "test/fixtures/v1-config-consumer");
const PASSTHROUGH_ENV = [
  "CARGO_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

function consumerEnvironment(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...values };
}

function validateExportWithPinnedV1(raw: string): unknown {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-v1-consumer-"));
  const consumer = path.join(temporaryRoot, "consumer");
  const archive = path.join(temporaryRoot, "consumer.tar");
  const input = path.join(temporaryRoot, "export.yaml");
  const settings = path.join(temporaryRoot, "settings.json");
  try {
    fs.writeFileSync(input, raw, { mode: 0o600 });
    execFileSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "archive",
        "--format=tar",
        `--output=${archive}`,
        V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
      ],
      { stdio: "pipe", timeout: 30_000 },
    );
    fs.mkdirSync(consumer);
    execFileSync("tar", ["-xf", archive, "-C", consumer], { stdio: "pipe", timeout: 30_000 });
    fs.copyFileSync(
      path.join(FIXTURE_ROOT, "config-export-compatibility.rs"),
      path.join(consumer, "crates/nemoclaw-sdk/tests/config_export_compatibility.rs"),
    );
    execFileSync(
      "cargo",
      ["test", "--locked", "-p", "nemoclaw-sdk", "--test", "config_export_compatibility"],
      {
        cwd: consumer,
        env: consumerEnvironment({
          CARGO_TARGET_DIR: path.join(temporaryRoot, "cargo-target"),
          NEMOCLAW_V1_CONFIG_INPUT: input,
          NEMOCLAW_V1_SETTINGS_OUTPUT: settings,
        }),
        maxBuffer: 10 * 1024 * 1024,
        stdio: "pipe",
        timeout: 8 * 60_000,
      },
    );
    const output = execFileSync(
      "python3",
      [path.join(FIXTURE_ROOT, "validate-native-settings.py"), consumer, settings],
      {
        encoding: "utf8",
        env: consumerEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    const evidence = JSON.parse(output) as Record<string, unknown>;
    return { revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION, ...evidence };
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

/** Verify generated OpenClaw and Hermes settings with the pinned v1 consumer. */
export function validateAgentExportsWithPinnedV1(raw: string): {
  revision: typeof V1ALPHA1_RUNTIME_DEFAULTS_REVISION;
  contextWindow: number;
  hermesInterfacesVerified: boolean;
} {
  return validateExportWithPinnedV1(raw) as {
    revision: typeof V1ALPHA1_RUNTIME_DEFAULTS_REVISION;
    contextWindow: number;
    hermesInterfacesVerified: boolean;
  };
}
