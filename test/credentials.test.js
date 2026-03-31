// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("credential prompts", () => {
  it("exits cleanly when answers are staged through a pipe", () => {
    const script = `
      set -euo pipefail
      pipe="$(mktemp -u)"
      mkfifo "$pipe"
      trap 'rm -f "$pipe"' EXIT
      {
        printf 'sandbox-name\\n'
        sleep 1
        printf 'n\\n'
      } > "$pipe" &
      ${JSON.stringify(process.execPath)} -e 'const { prompt } = require(${JSON.stringify(path.join(import.meta.dirname, "..", "bin", "lib", "credentials"))}); (async()=>{ await prompt("first: "); await prompt("second: "); })().catch(err=>{ console.error(err); process.exit(1); });' < "$pipe"
    `;

    const result = spawnSync("bash", ["-lc", script], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(0);
  });

  it("settles the outer prompt promise on secret prompt errors", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8"
    );

    expect(source).toMatch(/return new Promise\(\(resolve, reject\) => \{/);
    expect(source).toMatch(/reject\(err\);\s*process\.kill\(process\.pid, "SIGINT"\);/);
    expect(source).toMatch(/reject\(err\);\s*\}\);/);
  });

  it("re-raises SIGINT from standard readline prompts instead of treating it like an empty answer", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8"
    );

    expect(source).toContain('rl.on("SIGINT"');
    expect(source).toContain('new Error("Prompt interrupted")');
    expect(source).toContain('process.kill(process.pid, "SIGINT")');
  });

  it("normalizes credential values and keeps prompting on invalid NVIDIA API key prefixes", async () => {
    const credentials = await import("../bin/lib/credentials.js");
    expect(credentials.normalizeCredentialValue("  nvapi-good-key\r\n")).toBe("nvapi-good-key");

    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8"
    );
    expect(source).toMatch(/while \(true\) \{/);
    expect(source).toMatch(/Invalid key\. Must start with nvapi-/);
    expect(source).toMatch(/continue;/);
  });

  it("masks secret input with asterisks while preserving the underlying value", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "bin", "lib", "credentials.js"),
      "utf-8"
    );

    expect(source).toContain('output.write("*")');
    expect(source).toContain('output.write("\\b \\b")');
  });
});
