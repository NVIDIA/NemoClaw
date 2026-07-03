// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "..",
  "agents",
  "langchain-deepagents-code",
  "start.sh",
);

export function makeStartScriptFixture(tempDir: string): {
  envFile: string;
  scriptPath: string;
} {
  const envFile = path.join(tempDir, "proxy-env.sh");
  const scriptPath = path.join(tempDir, "start.sh");
  const hostFile = path.join(tempDir, "trusted-proxy-host");
  const portFile = path.join(tempDir, "trusted-proxy-port");
  const original = fs.readFileSync(START_SCRIPT, "utf8");
  assert.ok(original.includes("local target=/tmp/nemoclaw-proxy-env.sh"));
  assert.ok(original.includes('tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"'));
  const fixture = original
    .replace(
      'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/dcode-proxy-host"',
      `readonly MANAGED_PROXY_HOST_FILE="${hostFile}"`,
    )
    .replace(
      'readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/dcode-proxy-port"',
      `readonly MANAGED_PROXY_PORT_FILE="${portFile}"`,
    )
    .replace(
      "readonly MANAGED_PROXY_OWNER_UID=0",
      `readonly MANAGED_PROXY_OWNER_UID=${process.getuid?.() ?? 0}`,
    )
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${envFile}"`)
    .replace(
      'tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
      `tmp="$(mktemp "${tempDir}/nemoclaw-proxy-env.XXXXXX")"`,
    );
  assert.ok(fixture.includes(`local target="${envFile}"`));
  assert.ok(fixture.includes(`tmp="$(mktemp "${tempDir}/nemoclaw-proxy-env.XXXXXX")"`));
  assert.ok(!fixture.includes("local target=/tmp/nemoclaw-proxy-env.sh"));
  assert.ok(!fixture.includes('tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"'));
  fs.writeFileSync(hostFile, "10.200.0.1\n", "utf8");
  fs.writeFileSync(portFile, "3128\n", "utf8");
  fs.chmodSync(hostFile, 0o444);
  fs.chmodSync(portFile, 0o444);
  fs.writeFileSync(scriptPath, fixture, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return { envFile, scriptPath };
}
