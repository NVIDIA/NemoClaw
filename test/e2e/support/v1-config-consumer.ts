// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  V1ALPHA1_RUNTIME_DEFAULTS,
  V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
} from "../../../src/lib/domain/config/v1alpha1-runtime-defaults.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

const FIXTURE_ROOT = path.join(REPO_ROOT, "test/e2e/fixtures/v1-config-consumer");

interface ConsumerInput {
  readonly name: string;
  readonly harness: "hermes" | "openclaw";
  readonly raw: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly agentName?: string;
}

interface ConsumerEvidence {
  readonly revision: typeof V1ALPHA1_RUNTIME_DEFAULTS_REVISION;
  readonly documents: readonly {
    readonly name: string;
    readonly harness: ConsumerInput["harness"];
    readonly sha256: string;
    readonly native: {
      readonly source: Readonly<Record<string, unknown>>;
      readonly targetDefaults: Readonly<Record<string, unknown>>;
    };
  }[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function openClawTargetDefaults(): Record<string, unknown> {
  const defaults = V1ALPHA1_RUNTIME_DEFAULTS.openclaw;
  return {
    contextWindow: defaults.tuning.contextWindow,
    maxTokens: defaults.tuning.maxTokens,
    reasoning: defaults.tuning.reasoning,
    timeoutSeconds: defaults.execution.timeoutSeconds,
    heartbeatPresent: defaults.execution.heartbeatEvery !== null,
    dashboardEnabled: defaults.interfaces.dashboard.enabled,
    dashboardPort: defaults.interfaces.dashboard.port,
    dashboardBind: defaults.interfaces.dashboard.bind === "127.0.0.1" ? "loopback" : "lan",
    toolDisclosure: defaults.tools.disclosure,
    thinkingDefaultPresent: defaults.tuning.reasoningEffort !== "default",
  };
}

function hermesTargetDefaults(): Record<string, unknown> {
  const defaults = V1ALPHA1_RUNTIME_DEFAULTS.hermes.interfaces;
  return {
    apiPort: defaults.api.port,
    dashboard: {
      enabled: defaults.dashboard.enabled,
      port: defaults.dashboard.port,
      internalPort: defaults.dashboard.internalPort,
      tui: { enabled: defaults.dashboard.tuiEnabled },
    },
  };
}

/** Parse raw exports and evaluate their generated native settings with the pinned v1 consumer. */
export function validateWithRevisionMatchedV1Consumer(
  inputs: readonly ConsumerInput[],
): ConsumerEvidence {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-v1-consumer-"));
  const consumer = path.join(temporaryRoot, "consumer");
  const consumerArchive = path.join(temporaryRoot, "consumer.tar");
  const inputDirectory = path.join(temporaryRoot, "inputs");
  const settingsDirectory = path.join(temporaryRoot, "settings");
  const manifestPath = path.join(temporaryRoot, "manifest.json");
  const evidencePath = path.join(temporaryRoot, "evidence.json");
  try {
    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.mkdirSync(settingsDirectory, { recursive: true });
    const documents = inputs.map((input, index) => {
      const safeName = `${String(index).padStart(2, "0")}-${input.name.replace(/[^a-z0-9-]/giu, "-")}`;
      fs.writeFileSync(path.join(inputDirectory, `${safeName}.yaml`), input.raw, { mode: 0o600 });
      return {
        name: safeName,
        harness: input.harness,
        sha256: sha256(input.raw),
        source: input.source,
        ...(input.agentName ? { agentName: input.agentName } : {}),
        targetDefaults:
          input.harness === "openclaw" ? openClawTargetDefaults() : hermesTargetDefaults(),
      };
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify({ documents }, null, 2)}\n`, { mode: 0o600 });
    execFileSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "archive",
        "--format=tar",
        `--output=${consumerArchive}`,
        V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    fs.mkdirSync(consumer);
    execFileSync("tar", ["-xf", consumerArchive, "-C", consumer], {
      encoding: "utf8",
      stdio: "pipe",
    });
    fs.copyFileSync(
      path.join(FIXTURE_ROOT, "config-export-compatibility.rs"),
      path.join(consumer, "crates/nemoclaw-sdk/tests/config_export_compatibility.rs"),
    );
    execFileSync(
      "cargo",
      ["test", "--locked", "-p", "nemoclaw-sdk", "--test", "config_export_compatibility"],
      {
        cwd: consumer,
        encoding: "utf8",
        env: {
          ...process.env,
          CARGO_TARGET_DIR: path.join(
            os.tmpdir(),
            `nemoclaw-v1-target-${V1ALPHA1_RUNTIME_DEFAULTS_REVISION}`,
          ),
          NEMOCLAW_V1_CONFIG_INPUTS: inputDirectory,
          NEMOCLAW_V1_SETTINGS_OUTPUT: settingsDirectory,
        },
        maxBuffer: 10 * 1024 * 1024,
        stdio: "pipe",
      },
    );
    execFileSync(
      "python3",
      [
        path.join(FIXTURE_ROOT, "validate-native-settings.py"),
        "--consumer",
        consumer,
        "--settings",
        settingsDirectory,
        "--manifest",
        manifestPath,
        "--output",
        evidencePath,
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: "pipe" },
    );
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Omit<
      ConsumerEvidence,
      "revision"
    >;
    return { revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION, documents: evidence.documents };
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
