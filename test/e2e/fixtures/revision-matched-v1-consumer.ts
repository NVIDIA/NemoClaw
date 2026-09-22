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
import { decodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import type { SandboxEntry } from "../../../src/lib/state/registry/types.ts";
import { REPO_ROOT } from "./paths.ts";

const FIXTURE_ROOT = path.join(REPO_ROOT, "test/e2e/fixtures/v1-config-consumer");
const CONSUMER_COMMAND_TIMEOUT_MS = 30_000;
const CONSUMER_BUILD_TIMEOUT_MS = 4 * 60_000;
type RevisionMatchedLiveEntry = Pick<SandboxEntry, "name" | "agent" | "workload" | "hermesApiPort">;

export interface RevisionMatchedConsumerInput {
  readonly name: string;
  readonly harness: "hermes" | "openclaw";
  readonly raw: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly agentName?: string;
}

export interface RevisionMatchedConsumerEvidence {
  readonly revision: typeof V1ALPHA1_RUNTIME_DEFAULTS_REVISION;
  readonly documents: readonly {
    readonly name: string;
    readonly harness: RevisionMatchedConsumerInput["harness"];
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

function requiredNumber(value: number | null, field: string): number {
  if (value === null) throw new Error(`the live source is missing ${field}`);
  return value;
}

function openClawSource(entry: RevisionMatchedLiveEntry): Record<string, unknown> {
  if (entry.workload?.kind !== "managed-image") {
    throw new Error("revision-matched validation requires a managed-image workload");
  }
  const profile = decodeManagedStartupProfile(entry.workload.encodedProfile);
  if (
    profile.agent !== "openclaw" ||
    profile.agentConfig.agent !== "openclaw" ||
    profile.dashboard.agent !== "openclaw"
  ) {
    throw new Error("the live OpenClaw source does not match its managed startup profile");
  }
  return {
    contextWindow: requiredNumber(profile.tuning.contextWindow, "OpenClaw context window"),
    maxTokens: requiredNumber(profile.tuning.maxTokens, "OpenClaw maximum tokens"),
    reasoning: profile.tuning.reasoning,
    timeoutSeconds: profile.agentConfig.agentTimeoutSeconds,
    heartbeatPresent: profile.agentConfig.heartbeatEvery !== null,
    dashboardEnabled: true,
    dashboardPort: profile.dashboard.port,
    dashboardBind: profile.dashboard.bindAddress === "127.0.0.1" ? "loopback" : "lan",
    toolDisclosure: profile.tools.disclosure,
    explicitAgentOwnership: true,
    thinkingDefaultPresent: profile.tuning.reasoningEffort !== "default",
  };
}

function hermesSource(entry: RevisionMatchedLiveEntry): Record<string, unknown> {
  if (entry.workload?.kind !== "managed-image") {
    throw new Error("revision-matched validation requires a managed-image workload");
  }
  const profile = decodeManagedStartupProfile(entry.workload.encodedProfile);
  if (
    profile.agent !== "hermes" ||
    profile.agentConfig.agent !== "hermes" ||
    profile.dashboard.agent !== "hermes"
  ) {
    throw new Error("the live Hermes source does not match its managed startup profile");
  }
  const defaults = V1ALPHA1_RUNTIME_DEFAULTS.hermes.interfaces;
  const dashboard =
    profile.dashboard.mode === "loopback-forwarded"
      ? {
          enabled: true,
          port: profile.dashboard.publicPort,
          internalPort: profile.dashboard.internalPort,
          tui: { enabled: profile.dashboard.tuiEnabled },
        }
      : {
          enabled: false,
          port: defaults.dashboard.port,
          internalPort: defaults.dashboard.internalPort,
          tui: { enabled: defaults.dashboard.tuiEnabled },
        };
  return {
    apiPort: entry.hermesApiPort ?? defaults.api.port,
    dashboard,
  };
}

/** Parse raw exports and evaluate their generated native settings with the pinned v1 consumer. */
export function validateWithRevisionMatchedV1Consumer(
  inputs: readonly RevisionMatchedConsumerInput[],
): RevisionMatchedConsumerEvidence {
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
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: "pipe",
        timeout: CONSUMER_COMMAND_TIMEOUT_MS,
      },
    );
    fs.mkdirSync(consumer);
    execFileSync("tar", ["-xf", consumerArchive, "-C", consumer], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: "pipe",
      timeout: CONSUMER_COMMAND_TIMEOUT_MS,
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
        killSignal: "SIGKILL",
        stdio: "pipe",
        timeout: CONSUMER_BUILD_TIMEOUT_MS,
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
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 10 * 1024 * 1024,
        stdio: "pipe",
        timeout: CONSUMER_COMMAND_TIMEOUT_MS,
      },
    );
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Omit<
      RevisionMatchedConsumerEvidence,
      "revision"
    >;
    return { revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION, documents: evidence.documents };
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

export function revisionMatchedConsumerInputFromLiveSource(
  raw: string,
  entry: RevisionMatchedLiveEntry,
): RevisionMatchedConsumerInput {
  if (entry.agent !== "openclaw" && entry.agent !== "hermes") {
    throw new Error(
      `revision-matched validation does not support agent '${entry.agent ?? "unknown"}'`,
    );
  }
  return {
    name: `live-${entry.name}`,
    harness: entry.agent,
    raw,
    ...(entry.agent === "openclaw" ? { agentName: "primary" } : {}),
    source: entry.agent === "openclaw" ? openClawSource(entry) : hermesSource(entry),
  };
}

/** Validate one live CLI export against independently retained source state. */
export function validateLiveExportWithRevisionMatchedV1Consumer(
  raw: string,
  entry: RevisionMatchedLiveEntry,
): RevisionMatchedConsumerEvidence {
  return validateWithRevisionMatchedV1Consumer([
    revisionMatchedConsumerInputFromLiveSource(raw, entry),
  ]);
}
