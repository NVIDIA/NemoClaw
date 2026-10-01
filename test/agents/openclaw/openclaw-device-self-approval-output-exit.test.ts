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

type OutputFailure = "none" | "stall" | "callback-error";

function runPatchedApprove(
  json: boolean,
  useLocalFallback = true,
  outputFailure: OutputFailure = "none",
  keepLeftoverHandle = true,
) {
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
defaultRuntime.exit = (code) => realExit(code);
if (${JSON.stringify(outputFailure)} === "stall") {
  process.stdout.write = () => false;
  process.stderr.write = () => false;
} else if (${JSON.stringify(outputFailure)} === "callback-error") {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    if (String(chunk).length === 0) {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        queueMicrotask(() => callback(new Error("stdout-drain-failed")));
      }
      return false;
    }
    return stdoutWrite(chunk, ...args);
  };
}
if (${String(keepLeftoverHandle)}) setInterval(() => {}, 1000);
setApprovalFailures(${useLocalFallback ? '[new Error("scope-upgrade-pending")]' : "[]"});
const opts = { json: ${String(json)} };
approvePairingWithFallback(opts, "request-1")
  .then((result) => runDevicesApproveSuccess(result, opts))
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
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(outputFailure === "none" ? 0 : 1);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe(outputFailure === "stall" ? "" : "approved-stderr\n");
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
  ])("exits after direct gateway approval with a leftover handle", (json, expected) => {
    expect(runPatchedApprove(json, false)).toBe(expected);
  });

  it("returns failure when approval output does not drain within the bound", () => {
    expect(runPatchedApprove(false, false, "stall", false)).toBe("");
  });

  it("returns failure when an approval output callback reports an error", () => {
    expect(runPatchedApprove(false, false, "callback-error")).toBe("Approved ok (request-1)\n");
  });
});
