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
  status: "approved",
  requestId: "request-1",
  device: { deviceId: "device-1" },
};

function runPatchedApprove(json: boolean, useLocalFallback = true) {
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
defaultRuntime.log = (value) => {
  process.stdout.write(\`${"${String(value)}"}\\n\`);
  process.stderr.write("approved-stderr\\n");
};
defaultRuntime.writeJson = (value) => {
  process.stdout.write(\`${"${JSON.stringify(value)}"}\\n\`);
  process.stderr.write("approved-stderr\\n");
};
let actionSettled = false;
defaultRuntime.exit = (code) => realExit(actionSettled ? code : 23);
setInterval(() => {}, 1000);
setApprovalFailures(${useLocalFallback ? '[new Error("scope-upgrade-pending")]' : "[]"});
const opts = { json: ${String(json)} };
approvePairingWithFallback(opts, "request-1")
  .then((result) => runDevicesApproveSuccess(result, opts))
  .then(() => { actionSettled = true; })
  .catch((error) => {
    console.error(error);
    realExit(1);
  });
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
  expect(result.stderr).toBe("approved-stderr\n");
  return result.stdout;
}

describe("OpenClaw devices approve output before forced exit (#12064)", () => {
  it("flushes human output before exiting with a leftover handle", () => {
    expect(runPatchedApprove(false)).toBe("Approved device-1 (request-1)\n");
  });

  it("flushes JSON output before exiting with a leftover handle", () => {
    expect(JSON.parse(runPatchedApprove(true))).toEqual(APPROVAL);
  });

  it.each([
    [false, "Approved ok (request-1)\n"],
    [true, JSON.stringify({ requestId: "request-1", approved: true }) + "\n"],
  ])("exits after direct gateway approval settles", (json, expected) => {
    expect(runPatchedApprove(json, false)).toBe(expected);
  });
});
