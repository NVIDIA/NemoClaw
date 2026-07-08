// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, vi } from "vitest";

type SetupNim = (gpu: {
  type: string;
  name: string;
  count: number;
  totalMemoryMB: number;
  perGpuMB: number;
  nimCapable: boolean;
  unifiedMemory: boolean;
  spark: boolean;
  platform: string;
}) => Promise<{ provider: string; model: string }>;

function writeAlwaysOkCurl(fakeBin: string): void {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' '{"id":"ok"}' > "$outfile"
printf '%s' "200"
`,
    { mode: 0o755 },
  );
}

it("warns about arm64 NIM image compatibility when Local NIM is offered on DGX Spark", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-arm64-nim-warning-"));
  const fakeBin = path.join(tmpDir, "bin");

  fs.mkdirSync(fakeBin, { recursive: true });
  writeAlwaysOkCurl(fakeBin);

  const originalArch = process.arch;
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };
  const lines: string[] = [];
  const originalLog = console.log;

  vi.resetModules();
  Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  process.env = {
    ...originalEnv,
    HOME: tmpDir,
    PATH: `${fakeBin}:${originalEnv.PATH || ""}`,
    NEMOCLAW_EXPERIMENTAL: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PROVIDER: "build",
    NVIDIA_INFERENCE_API_KEY: "nvapi-test",
  };
  console.log = (...args: unknown[]) => lines.push(args.join(" "));

  vi.doMock("../src/lib/credentials/store.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/credentials/store.js")>()),
    prompt: async () => "",
    ensureApiKey: async () => {},
  }));
  vi.doMock("../src/lib/runner.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/runner.js")>()),
    runCapture: (_command: readonly string[]) => "",
  }));

  try {
    const { setupNim } = (await import("../src/lib/onboard.js")) as unknown as {
      setupNim: SetupNim;
    };
    const result = await setupNim({
      type: "nvidia",
      name: "NVIDIA GB10",
      count: 1,
      totalMemoryMB: 124607,
      perGpuMB: 124607,
      nimCapable: true,
      unifiedMemory: true,
      spark: true,
      platform: "spark",
    });

    assert.equal(result.provider, "nvidia-prod");
    assert.equal(result.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.ok(
      lines.some((line) =>
        line.includes("Local NVIDIA NIM is experimental on Linux arm64 DGX Spark hosts"),
      ),
    );
    assert.ok(lines.some((line) => line.includes("linux/arm64 manifests")));
  } finally {
    console.log = originalLog;
    process.env = originalEnv;
    Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.doUnmock("../src/lib/credentials/store.js");
    vi.doUnmock("../src/lib/runner.js");
  }
});
