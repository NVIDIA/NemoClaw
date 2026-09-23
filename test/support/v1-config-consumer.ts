// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HERMES_INTERFACE_DEFAULTS } from "../../src/lib/config/model";
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

export interface PinnedV1OpenClawNativeSettings {
  model: { contextWindow: number; maxTokens: number; reasoning: boolean };
  reasoningEffort: string;
  execution: { timeoutSeconds: number; heartbeatEvery: string | null };
  dashboard: { enabled: boolean; port: number; bind: string };
  toolDisclosure: string;
}

export interface PinnedV1HermesNativeSettings {
  apiPort: number;
  dashboard: {
    enabled: boolean;
    port: number;
    internalPort: number;
    tui: { enabled: boolean };
  };
}

export interface PinnedV1HermesSourceSettings {
  hermesApiPort?: number | null;
  hermesDashboardEnabled?: boolean;
  hermesDashboardPort?: number | null;
  hermesDashboardInternalPort?: number | null;
  hermesDashboardTui?: boolean;
}

/** Resolve pinned native values from retained Hermes source intent, not from compiled output. */
export function expectedPinnedV1HermesNativeSettings(
  source: PinnedV1HermesSourceSettings,
): PinnedV1HermesNativeSettings {
  const enabled = source.hermesDashboardEnabled === true;
  return {
    apiPort: source.hermesApiPort ?? HERMES_INTERFACE_DEFAULTS.apiPort,
    dashboard: {
      enabled,
      port: enabled
        ? (source.hermesDashboardPort ?? HERMES_INTERFACE_DEFAULTS.dashboardPort)
        : HERMES_INTERFACE_DEFAULTS.dashboardPort,
      internalPort: enabled
        ? (source.hermesDashboardInternalPort ?? HERMES_INTERFACE_DEFAULTS.dashboardInternalPort)
        : HERMES_INTERFACE_DEFAULTS.dashboardInternalPort,
      // The pinned adapter retains its inactive default when the dashboard is disabled.
      tui: { enabled: enabled ? source.hermesDashboardTui === true : true },
    },
  };
}

export interface PinnedV1ConsumerEvidence {
  revision: typeof V1ALPHA1_RUNTIME_DEFAULTS_REVISION;
  compiledSandboxes?: number;
  contextWindows?: number[];
  hermesNativeSettings?: Record<string, PinnedV1HermesNativeSettings>;
  openclawNativeSettings?: Record<string, PinnedV1OpenClawNativeSettings>;
  openclawNativeSettingsVerified?: number;
  hermesNativeSettingsVerified?: number;
}

/** Parse an exact export and generate its native settings with the pinned v1 consumer. */
export function validateConfigExportWithPinnedV1(raw: string): PinnedV1ConsumerEvidence {
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
    return {
      revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
      ...evidence,
    } as unknown as PinnedV1ConsumerEvidence;
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
