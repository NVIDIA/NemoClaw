// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  runPatch,
  writeFixtureDist,
} from "../../helpers/openclaw-device-self-approval-patch-harness";

const APPROVAL = {
  requestId: "request-1",
  device: { deviceId: "device-1" },
};

function runPatchedApprove(json: boolean) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-approve-output-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(dist);
  writeFixtureDist(dist);
  const patch = runPatch(dist);
  expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
  const source = fs.readFileSync(path.join(dist, "devices-cli.runtime-fixture.js"), "utf8");
  const runner = path.join(tmp, "approve-output-runner.cjs");
  fs.writeFileSync(
    runner,
    `const realExit = globalThis.process.exit.bind(globalThis.process);
${source}
defaultRuntime.log = (value) => process.stdout.write(\`${"${String(value)}"}\\n\`);
defaultRuntime.writeJson = (value) => process.stdout.write(\`${"${JSON.stringify(value)}"}\\n\`);
defaultRuntime.exit = (code) => realExit(code);
setInterval(() => {}, 1000);
runDevicesApproveSuccess(${JSON.stringify(APPROVAL)}, { json: ${String(json)} });
`,
  );
  const result = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    timeout: 3000,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.signal).toBeNull();
  return result.stdout;
}

describe("OpenClaw devices approve output before forced exit (#12064)", () => {
  it("flushes human output before exiting with a leftover handle", () => {
    expect(runPatchedApprove(false)).toBe("Approved device-1 (request-1)\n");
  });

  it("flushes JSON output before exiting with a leftover handle", () => {
    expect(JSON.parse(runPatchedApprove(true))).toEqual(APPROVAL);
  });
});
