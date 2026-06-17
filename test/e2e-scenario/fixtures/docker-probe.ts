// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ArtifactSink } from "./artifacts.ts";
import { buildChildEnv } from "./redaction.ts";
import type { SecretStore } from "./secrets.ts";

export type DockerCommandResult = {
  command: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type DockerProbeRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

const DOCKER_ENV_ALLOWLIST = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "XDG_RUNTIME_DIR",
] as const;

function safeName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "docker"
  );
}

export function buildDockerProbeEnv(
  base: NodeJS.ProcessEnv,
  dockerConfigDir: string,
): NodeJS.ProcessEnv {
  return buildChildEnv(base, {
    additionalAllowedEnv: DOCKER_ENV_ALLOWLIST,
    fixtureOverlay: {
      DOCKER_CONFIG: dockerConfigDir,
    },
  });
}

export function redactDockerProbeResult(
  result: DockerCommandResult,
  redact: SecretStore["redact"],
): DockerCommandResult {
  return {
    command: result.command.map((part) => redact(part)),
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    error: result.error ? redact(result.error) : undefined,
  };
}

export function resultText(result: DockerCommandResult): string {
  return [
    `$ ${result.command.join(" ")}`,
    result.stdout.trim(),
    result.stderr.trim(),
    result.error ? `error: ${result.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export class DockerProbe {
  private sequence = 0;
  private readonly dockerConfigDir: string;

  constructor(
    private readonly artifacts: ArtifactSink,
    private readonly redact: SecretStore["redact"],
    private readonly runDocker: DockerProbeRunner = spawnSync,
  ) {
    this.dockerConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-config-"));
  }

  async run(
    args: string[],
    options: { artifactName: string; timeoutMs?: number } = { artifactName: "docker" },
  ): Promise<DockerCommandResult> {
    fs.mkdirSync(this.dockerConfigDir, { recursive: true });
    const command = ["docker", ...args];
    const result = this.runDocker("docker", args, {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      env: buildDockerProbeEnv(process.env, this.dockerConfigDir),
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
    });
    const commandResult = redactDockerProbeResult(
      {
        command,
        exitCode: result.status,
        signal: result.signal,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error instanceof Error ? result.error.message : undefined,
      },
      this.redact,
    );
    const artifactBase = `docker/${String(++this.sequence).padStart(3, "0")}-${safeName(
      options.artifactName,
    )}`;
    await this.artifacts.writeText(`${artifactBase}.stdout.txt`, commandResult.stdout);
    await this.artifacts.writeText(`${artifactBase}.stderr.txt`, commandResult.stderr);
    await this.artifacts.writeJson(`${artifactBase}.result.json`, commandResult);
    return commandResult;
  }

  async expect(
    args: string[],
    options: { artifactName: string; timeoutMs?: number },
  ): Promise<DockerCommandResult> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw new Error(resultText(result));
    }
    return result;
  }
}
