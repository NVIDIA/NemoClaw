// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { redactString } from "../fixtures/redaction.ts";
import { ShellProbe, trustedShellCommand } from "../fixtures/shell-probe.ts";

function supportProgress() {
  return startTestProgress(
    "Forbidden output detection",
    ["run output probe", "verify redacted evidence"],
    { logLine: () => undefined },
  );
}

describe("pre-redaction forbidden output detection", () => {
  it.each([
    { stream: "stdout", captureLimitBytes: undefined, expected: true, redacted: true },
    { stream: "stderr", captureLimitBytes: undefined, expected: true, redacted: true },
    { stream: "stdout", captureLimitBytes: 16, expected: true, redacted: false },
    { stream: "stderr", captureLimitBytes: 16, expected: true, redacted: false },
    { stream: "separate", captureLimitBytes: undefined, expected: true, redacted: true },
    { stream: "separate", captureLimitBytes: 16, expected: true, redacted: true },
    { stream: "separate-reversed", captureLimitBytes: undefined, expected: true, redacted: true },
    { stream: "none", captureLimitBytes: undefined, expected: false, redacted: false },
  ])(
    "detects forbidden output before redaction and truncation ($stream, limit=$captureLimitBytes)",
    async ({ stream, captureLimitBytes, expected, redacted }) => {
      const secret = "opaque-forbidden-output-fixture";
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-forbidden-output-"));
      const progress = supportProgress();
      try {
        const probe = new ShellProbe({
          artifacts: new ArtifactSink(rootDir),
          progress,
          redact: (text, extra) => redactString(text, extra),
          signal: new AbortController().signal,
        });
        const result = await probe.run(
          trustedShellCommand({
            command: process.execPath,
            args: [
              "-e",
              `const marker = process.env.MARKER;
const stream = process.env.OUTPUT_STREAM;
if (stream === 'separate') {
  process.stdout.write(marker.slice(0, 12));
  process.stderr.write(marker.slice(12));
} else if (stream === 'separate-reversed') {
  process.stderr.write(marker.slice(0, 12));
  process.stdout.write(marker.slice(12));
} else if (stream !== 'none') {
  process[stream].write(marker.slice(0, 12));
  setTimeout(() => process[stream].write(marker.slice(12) + '\\n' + 'tail'.repeat(100)), 50);
} else {
  process.stdout.write('safe output');
}`,
            ],
            reason: "detect forbidden output without exposing its contents",
          }),
          {
            artifactName: "forbidden-output",
            captureLimitBytes,
            env: { MARKER: secret, OUTPUT_STREAM: stream },
            forbiddenOutputValues: [secret],
          },
        );
        expect(result.exitCode).toBe(0);
        expect(result).toHaveProperty("forbiddenOutputDetected", expected);
        expect(JSON.stringify(result)).not.toContain(secret);
        const evidence = await Promise.all(
          Object.values(result.artifacts).map((artifactPath) => fs.readFile(artifactPath, "utf8")),
        );
        expect(evidence.join("\n")).not.toContain(secret);
        expect(evidence.join("")).not.toContain(secret);
        expect(result.stdout + result.stderr).not.toContain(secret);
        expect((result.stdout + result.stderr).includes("[REDACTED]")).toBe(redacted);
      } finally {
        progress.stop();
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
