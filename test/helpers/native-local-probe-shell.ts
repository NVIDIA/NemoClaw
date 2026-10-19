// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxInferenceInvocationDeps } from "../../src/lib/actions/sandbox/inference-invocation-probe";

/** The shape OpenShell issues for an attached native local provider credential. */
export const NATIVE_LOCAL_CREDENTIAL_HANDLE =
  "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN";

/**
 * Run each generated probe command in a real shell whose curl records its
 * arguments and answers with a fixed HTTP status and body. The recorded
 * arguments show the actual request destination and headers.
 */
export function recordingProbeShell(
  code: string,
  body = "",
  environment: NodeJS.ProcessEnv = {
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: NATIVE_LOCAL_CREDENTIAL_HANDLE,
  },
) {
  const requests: string[][] = [];
  const execute: NonNullable<SandboxInferenceInvocationDeps["execute"]> = async (
    _sandboxName,
    command,
  ) => {
    const dir = mkdtempSync(path.join(tmpdir(), "nemoclaw-probe-route-"));
    try {
      const bin = path.join(dir, "bin");
      const argv = path.join(dir, "argv.txt");
      mkdirSync(bin);
      writeFileSync(path.join(dir, "body.txt"), body);
      writeFileSync(
        path.join(bin, "curl"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$@" > ${JSON.stringify(argv)}`,
          'out=""; prev=""',
          'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
          `cat ${JSON.stringify(path.join(dir, "body.txt"))} > "$out"`,
          `printf '%s' ${JSON.stringify(code)}`,
        ].join("\n"),
        { mode: 0o755 },
      );
      const run = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...environment },
      });
      try {
        requests.push(readFileSync(argv, "utf8").trimEnd().split("\n"));
      } catch {
        /* curl was not reached */
      }
      return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    execute,
    requests,
    destinations: () => requests.map((argv) => argv.at(-1)),
  };
}
