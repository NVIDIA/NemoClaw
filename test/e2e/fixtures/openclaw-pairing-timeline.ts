// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import type { SandboxClient } from "./clients/sandbox.ts";

const COLLECTOR_FILE_NAME = "openclaw-pairing-timeline.py";
export const OPENCLAW_PAIRING_TIMELINE_LOCAL_PATH = fileURLToPath(
  new URL(`../lib/${COLLECTOR_FILE_NAME}`, import.meta.url),
);
// OpenShell treats the upload destination as a directory. Upload to /tmp and
// run the uploaded collector by its basename.
const COLLECTOR_REMOTE_DIR = "/tmp";
export const OPENCLAW_PAIRING_TIMELINE_REMOTE_PATH = `${COLLECTOR_REMOTE_DIR}/${COLLECTOR_FILE_NAME}`;

/** In-sandbox inputs of the collector; tests point them at a fixture tree. */
export interface OpenClawPairingTimelineInputs {
  stateDir: string;
  statusPath: string;
  autoPairLogPath: string;
  procRoot: string;
}

export const OPENCLAW_PAIRING_TIMELINE_INPUTS: OpenClawPairingTimelineInputs = {
  stateDir: "/sandbox/.openclaw",
  statusPath: "/tmp/nemoclaw-auto-pair-status.json",
  autoPairLogPath: "/tmp/auto-pair.log",
  procRoot: "/proc",
};

const UPLOAD_TIMEOUT_MS = 60_000;
const EXEC_GRACE_MS = 30_000;
const CAPTURE_LIMIT_BYTES = 256 * 1024;

interface OpenClawPairingTimelineOptions {
  artifactName: string;
  env: NodeJS.ProcessEnv;
  redactionValues: readonly string[];
  sandboxName: string;
  /** Seconds the collector polls when the first read of `paired.json` does not include the local CLI device. */
  waitSeconds: number;
}

export function buildOpenClawPairingTimelineCommand(
  waitSeconds: number,
  inputs: OpenClawPairingTimelineInputs = OPENCLAW_PAIRING_TIMELINE_INPUTS,
  collectorPath: string = OPENCLAW_PAIRING_TIMELINE_REMOTE_PATH,
): string[] {
  return [
    "python3",
    collectorPath,
    inputs.stateDir,
    inputs.statusPath,
    inputs.autoPairLogPath,
    inputs.procRoot,
    String(waitSeconds),
  ];
}

/** Parse the collector's last stdout line as untrusted data; anything but a JSON object is null. */
export function parseOpenClawPairingTimeline(stdout: string): Record<string, unknown> | null {
  const lastLine = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  try {
    const value: unknown = JSON.parse(lastLine);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Upload and run the collector while capturing upload and exec artifacts. Never replace the scenario's primary failure. */
export async function captureOpenClawPairingTimeline(
  sandbox: Pick<SandboxClient, "exec" | "upload">,
  options: OpenClawPairingTimelineOptions,
): Promise<Record<string, unknown> | null> {
  const redactionValues = [...options.redactionValues];
  try {
    await sandbox.upload(
      options.sandboxName,
      OPENCLAW_PAIRING_TIMELINE_LOCAL_PATH,
      COLLECTOR_REMOTE_DIR,
      {
        artifactName: `${options.artifactName}-upload`,
        env: options.env,
        redactionValues,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      },
    );
    const result = await sandbox.exec(
      options.sandboxName,
      buildOpenClawPairingTimelineCommand(options.waitSeconds),
      {
        artifactName: options.artifactName,
        captureLimitBytes: CAPTURE_LIMIT_BYTES,
        env: options.env,
        redactionValues,
        timeoutMs: options.waitSeconds * 1000 + EXEC_GRACE_MS,
      },
    );
    return parseOpenClawPairingTimeline(result.stdout);
  } catch {
    return null;
  }
}
