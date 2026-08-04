// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import os from "node:os";
import path from "node:path";

export const CONTAINER_REACHABILITY_IMAGE = "curlimages/curl:8.10.1";

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
    const outputPath = curlOutputPath(args);
    const outputDir = path.dirname(outputPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    return spawnSyncImpl(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        `${uid}:${gid}`,
        "--volume",
        `${outputDir}:${outputDir}`,
        CONTAINER_REACHABILITY_IMAGE,
        ...args,
      ],
      options,
    );
  };
}
