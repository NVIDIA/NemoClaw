// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ArtifactSink } from "./artifacts.ts";
import { type ChildProcessProgress, spawnObservedChild } from "./observed-child-process.ts";
import { buildChildEnv } from "./redaction.ts";
import type { SecretStore } from "./secrets.ts";
import { superviseChild } from "./shell/supervisor.ts";
import type { AbortSignalSource } from "./shell-probe.ts";

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

type DockerProbeRunOptions = {
  artifactName: string;
  timeoutMs?: number;
  artifactRedactionValues?: string[];
  returnRaw?: boolean;
};

const DOCKER_ENV_ALLOWLIST = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "XDG_RUNTIME_DIR",
] as const;
const MAX_DOCKER_OUTPUT_BYTES = 10 * 1024 * 1024;

function appendBoundedOutput(output: Buffer, chunk: string): Buffer | null {
  const combined = Buffer.concat([output, Buffer.from(chunk, "utf8")]);
  return combined.length <= MAX_DOCKER_OUTPUT_BYTES ? combined : null;
}

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
    private readonly runDocker?: DockerProbeRunner,
    private readonly progress?: ChildProcessProgress,
    private readonly signal?: AbortSignalSource,
  ) {
    this.dockerConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-config-"));
  }

  async run(
    args: string[],
    options: DockerProbeRunOptions = { artifactName: "docker" },
  ): Promise<DockerCommandResult> {
    const signal = typeof this.signal === "function" ? this.signal() : this.signal;
    fs.mkdirSync(this.dockerConfigDir, { recursive: true });
    const command = ["docker", ...args];
    const timeoutMs = options.timeoutMs ?? 30_000;
    const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      env: buildDockerProbeEnv(process.env, this.dockerConfigDir),
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
    };
    let rawCommandResult: DockerCommandResult;
    if (this.runDocker) {
      const result = this.runDocker("docker", args, spawnOptions);
      rawCommandResult = {
        command,
        exitCode: result.status,
        signal: result.signal,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error instanceof Error ? result.error.message : undefined,
      };
    } else {
      if (!this.progress) {
        throw new Error("DockerProbe requires progress hooks when using the real Docker CLI");
      }
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let outputExceeded = false;
      const child = spawnObservedChild("docker", args, {
        activityLabel: `command: docker-${safeName(options.artifactName)}`,
        progress: this.progress,
        spawn: {
          cwd: spawnOptions.cwd,
          detached: true,
          env: spawnOptions.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      });
      const stopForOutputLimit = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const supervised = await superviseChild(child, {
        timeoutMs,
        killGraceMs: 1_000,
        signal,
        onStdout: (chunk) => {
          if (outputExceeded) return;
          const next = appendBoundedOutput(stdout, chunk);
          if (next) {
            stdout = next;
            return;
          }
          outputExceeded = true;
          stdout = Buffer.alloc(0);
          stderr = Buffer.alloc(0);
          stopForOutputLimit();
        },
        onStderr: (chunk) => {
          if (outputExceeded) return;
          const next = appendBoundedOutput(stderr, chunk);
          if (next) {
            stderr = next;
            return;
          }
          outputExceeded = true;
          stdout = Buffer.alloc(0);
          stderr = Buffer.alloc(0);
          stopForOutputLimit();
        },
      });
      rawCommandResult = {
        command,
        exitCode: supervised.exitCode,
        signal: supervised.signal,
        stdout: outputExceeded
          ? "[docker-probe output exceeded safe capture limit]"
          : stdout.toString("utf8"),
        stderr: outputExceeded
          ? "[docker-probe output exceeded safe capture limit]"
          : stderr.toString("utf8"),
        error:
          supervised.spawnError?.message ??
          (outputExceeded ? "Docker output exceeded the safe capture limit" : undefined),
      };
    }
    const commandResult = redactDockerProbeResult(rawCommandResult, (text) =>
      this.redact(text, options.artifactRedactionValues ?? []),
    );
    const artifactBase = `docker/${String(++this.sequence).padStart(3, "0")}-${safeName(
      options.artifactName,
    )}`;
    await this.artifacts.writeText(`${artifactBase}.stdout.txt`, commandResult.stdout);
    await this.artifacts.writeText(`${artifactBase}.stderr.txt`, commandResult.stderr);
    await this.artifacts.writeJson(`${artifactBase}.result.json`, commandResult);
    return options.returnRaw === true ? rawCommandResult : commandResult;
  }

  async expect(args: string[], options: DockerProbeRunOptions): Promise<DockerCommandResult> {
    if (options.returnRaw === true) {
      throw new Error(
        "DockerProbe.expect cannot return raw Docker output; use run(..., { returnRaw: true }) only for explicit leak assertions that never log the raw result.",
      );
    }
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw new Error(resultText(result));
    }
    return result;
  }
}

export class DockerPrerequisite {
  constructor(
    private readonly probe: DockerProbe,
    private readonly skip: (reason: string) => never,
    private readonly isCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true",
  ) {}

  probeDocker(): Promise<DockerCommandResult> {
    return this.probe.run(["info"], { artifactName: "docker-info" });
  }

  async requireDocker(): Promise<DockerCommandResult> {
    const result = await this.probeDocker();
    if (result.exitCode === 0) return result;
    const message = `Docker is required for this live E2E target:\n${resultText(result)}`;
    if (this.isCi) throw new Error(message);
    return this.skip(message);
  }

  async expectMissingDocker(): Promise<DockerCommandResult> {
    const result = await this.probeDocker();
    if (result.exitCode !== 0) return result;
    throw new Error("Docker was expected to be unavailable for this E2E target");
  }
}
