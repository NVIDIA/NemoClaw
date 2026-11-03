// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { dockerCapture, dockerSpawn } from "../../adapters/docker";
import type { runCapture } from "../../runner";
import { runCurlProbe } from "../../adapters/http/probe";
import { VLLM_PORT } from "../../core/vllm-port";
import { BoundedLineDecoder } from "../../core/bounded-line-transcript";
import { buildModelListProbeCommand, isOpenAiModelListResponse } from "../nim";

const LOG_LINES = 80;
const LOG_TIMEOUT_MS = 5_000;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z (.*)$/;

type CaptureOperation = typeof runCapture;
type DockerOperations = {
  dockerCapture: typeof dockerCapture;
  dockerSpawn: typeof dockerSpawn;
};

async function readBeforeRestart(
  containerName: string,
  dockerEnv: Record<string, string>,
  until: string,
  spawn: typeof dockerSpawn,
): Promise<string[]> {
  try {
    const child = spawn(
      ["logs", "--timestamps", "--tail", "all", "--until", until, containerName],
      {
        env: dockerEnv,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: LOG_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    return await new Promise((resolve) => {
      const lines: { at: string; text: string }[] = [];
      let failed = false;
      const onLine = (line: string) => {
        const match = TIMESTAMP.exec(line);
        // Oversized lines lose their timestamp in BoundedLineDecoder. Drop the
        // whole record so a discarded credential prefix cannot expose its value.
        if (!match) return;
        lines.push({ at: `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}`, text: match[3]! });
        lines.sort((left, right) => left.at.localeCompare(right.at));
        if (lines.length > LOG_LINES) lines.shift();
      };
      const stdout = new BoundedLineDecoder({ maxPendingChars: 16 * 1024, onLine });
      const stderr = new BoundedLineDecoder({ maxPendingChars: 16 * 1024, onLine });
      child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        stdout.end();
        stderr.end();
        resolve(failed || code !== 0 ? [] : lines.map(({ text }) => text));
      });
    });
  } catch {
    return [];
  }
}

/** Keep a new attempt's pip output from hiding the preceding startup failure. */
export async function readVllmStartupLogExcerpts(
  containerName: string,
  dockerEnv: Record<string, string>,
  operations: DockerOperations,
): Promise<{ lines: string[]; suffix: string }[]> {
  const startedAt = operations
    .dockerCapture(
      [
        "inspect",
        "--format",
        "{{if gt .RestartCount 0}}{{.State.StartedAt}}{{end}}",
        containerName,
      ],
      { env: dockerEnv, ignoreError: true, timeout: LOG_TIMEOUT_MS },
    )
    .trim();
  const excerpts: { lines: string[]; suffix: string }[] = [];
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(startedAt)) {
    // Docker applies --tail before --until. Stream retained history instead,
    // bounding the process time, pending line size, and retained line count.
    excerpts.push({
      lines: await readBeforeRestart(containerName, dockerEnv, startedAt, operations.dockerSpawn),
      suffix: " before the latest restart",
    });
  }
  const current = operations
    .dockerCapture(["logs", "--tail", String(LOG_LINES), containerName], {
      env: dockerEnv,
      ignoreError: true,
      includeStderr: true,
    })
    .trim();
  excerpts.push({ lines: current ? current.split(/\r?\n/) : [], suffix: "" });
  return excerpts;
}

export function vllmEndpointReady(
  baseUrl: string | undefined,
  runCapture: CaptureOperation,
): boolean {
  if (baseUrl) {
    // The dual-Station /v1 surface is bearer-protected. vLLM deliberately
    // leaves /health outside its auth middleware, so readiness can stay
    // secret-free while onboarding separately validates model inventory with
    // the persisted key.
    return runCurlProbe(
      ["-sS", "--connect-timeout", "2", "--max-time", "5", `${baseUrl.replace(/\/+$/, "")}/health`],
      { pinnedAddresses: [] },
    ).ok;
  }
  const response = runCapture(
    buildModelListProbeCommand(
      ["--connect-timeout", "2", "--max-time", "5"],
      `http://127.0.0.1:${String(VLLM_PORT)}/v1/models`,
    ),
    { ignoreError: true },
  );
  return isOpenAiModelListResponse(response);
}
