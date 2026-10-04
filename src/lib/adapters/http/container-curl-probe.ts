// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONTAINER_REACHABILITY_IMAGE =
  "docker.io/curlimages/curl@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b";
const MAX_CONTAINER_CURL_STDOUT_BYTES = 8 * 1024 * 1024 + 256;
const HTTP_STATUS_MARKER_PREFIX = "\n__NEMOCLAW_CONTAINER_HTTP_STATUS_";

type CurlProbeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

function curlOutputPath(args: readonly string[]): string {
  const outputIndex = args.indexOf("-o");
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!outputPath || !path.isAbsolute(outputPath)) {
    throw new Error("container curl probe requires an absolute output path");
  }
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(outputPath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("container curl probe output must stay inside the temporary directory");
  }
  return outputPath;
}

function prepareContainerArgs(args: readonly string[]): {
  args: string[];
  outputPath: string;
  statusMarker: string;
} {
  const outputPath = curlOutputPath(args);
  const outputIndex = args.indexOf("-o");
  const containerArgs = [...args.slice(0, outputIndex), ...args.slice(outputIndex + 2)];
  const writeOutIndex = containerArgs.indexOf("-w");
  if (writeOutIndex < 0 || containerArgs[writeOutIndex + 1] !== "%{http_code}") {
    throw new Error("container curl probe requires the HTTP status write-out");
  }
  const statusMarker = `${HTTP_STATUS_MARKER_PREFIX}${randomUUID()}__:`;
  containerArgs[writeOutIndex + 1] = `${statusMarker}%{http_code}`;
  return { args: containerArgs, outputPath, statusMarker };
}

function splitContainerOutput(
  stdout: string,
  statusMarker: string,
): { body: string; httpStatus: string } {
  const markerIndex = stdout.lastIndexOf(statusMarker);
  if (markerIndex < 0) {
    throw new Error("container curl probe did not return the HTTP status write-out");
  }
  const httpStatus = stdout.slice(markerIndex + statusMarker.length).trim();
  if (!/^\d{3}$/.test(httpStatus)) {
    throw new Error("container curl probe returned an invalid HTTP status write-out");
  }
  return { body: stdout.slice(0, markerIndex), httpStatus };
}

function writeProbeOutput(outputPath: string, body: string): void {
  const fileDescriptor = fs.openSync(outputPath, "wx", 0o600);
  try {
    fs.writeFileSync(fileDescriptor, body, "utf8");
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

/** Run a credential-free curl probe from Docker Desktop's network context. */
export function createContainerCurlProbeSpawn(
  spawnSyncImpl: CurlProbeSpawn = spawnSync,
): CurlProbeSpawn {
  return (command, args, options) => {
    if (command !== "curl") {
      throw new Error(`container curl probe expected curl, received ${command}`);
    }
    if (
      args.some(
        (arg) =>
          arg === "--config" || arg === "-K" || arg.startsWith("--config=") || arg.startsWith("-K"),
      )
    ) {
      throw new Error("container curl probe does not accept credential config files");
    }
    // Docker Desktop containers may not share the WSL filesystem that owns this temporary path.
    // Capture the response on stdout so the host process writes the body to the WSL file.
    const prepared = prepareContainerArgs(args);
    const result = spawnSyncImpl(
      "docker",
      ["run", "--rm", CONTAINER_REACHABILITY_IMAGE, ...prepared.args],
      { ...options, maxBuffer: options.maxBuffer ?? MAX_CONTAINER_CURL_STDOUT_BYTES },
    );
    if (result.error || result.status !== 0) return result;

    const output = splitContainerOutput(String(result.stdout || ""), prepared.statusMarker);
    writeProbeOutput(prepared.outputPath, output.body);
    return { ...result, stdout: output.httpStatus };
  };
}
