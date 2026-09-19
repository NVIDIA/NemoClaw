// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { relayWorkloadSource } from "./native-nemocua-relay.mts";
import { claimNativeUiTunnelFrame } from "./native-ui-tunnel.mts";

test("native UI tunnel claims a frame before delivering it", () => {
  const removed: string[] = [];
  assert.deepEqual(
    claimNativeUiTunnelFrame(
      "C:\\relay\\stream-1\\host-0000000007.bin",
      {
        startedMs: 10,
        attempts: 2,
      },
      {
        platform: "win32",
        unlink: (file) => {
          removed.push(file);
        },
      },
    ),
    { claimed: true },
  );
  assert.deepEqual(removed, ["C:\\relay\\stream-1\\host-0000000007.bin"]);
});

test("native UI tunnel retries only transient Windows sharing denials", () => {
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    let attempts = 0;
    assert.deepEqual(
      claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
        platform: "win32",
        now: () => 100,
        unlink: () => {
          attempts++;
          throw Object.assign(new Error("transient sharing denial"), { code });
        },
      }),
      { claimed: false, retry: { startedMs: 100, attempts: 1 } },
    );
    assert.equal(attempts, 1);
  }
  for (const [platform, code] of [
    ["linux", "EBUSY"],
    ["win32", "EIO"],
  ] as const)
    assert.throws(() =>
      claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
        platform,
        unlink: () => {
          throw Object.assign(new Error("non-retryable unlink failure"), { code });
        },
      }),
    );
});

test("native UI tunnel sharing retries are bounded", () => {
  const unlink = () => {
    throw Object.assign(new Error("persistent sharing denial"), { code: "EBUSY" });
  };
  const first = claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
    platform: "win32",
    now: () => 100,
    unlink,
  });
  assert.equal(first.claimed, false);
  assert.throws(
    () =>
      claimNativeUiTunnelFrame(
        "C:\\relay\\stream-1\\host-0000000007.bin",
        first.claimed ? undefined : first.retry,
        { platform: "win32", now: () => 350, unlink },
      ),
    /remained locked after 2 bounded attempts/u,
  );
});

test("contained NemoCUA claims each ordered frame before delivery", (context) => {
  const source = relayWorkloadSource();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemocua-relay-source-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worker = path.join(root, "worker.mjs");
  fs.writeFileSync(worker, source, { flag: "wx" });
  execFileSync(process.execPath, ["--check", worker], { stdio: "pipe" });

  const read = source.indexOf("const bytes = fs.readFileSync(file);");
  const claim = source.indexOf("if (!claim(file)) break;", read);
  const write = source.indexOf("stream.socket.write(bytes);", claim);
  assert(read >= 0 && claim > read && write > claim);
  assert(source.includes('process.platform !== "win32"'));
  assert(source.includes('["EACCES", "EBUSY", "EPERM"].includes(error.code)'));
  assert(source.includes("now - retry.startedMs >= 250"));
  assert(source.includes("delivered === incoming.length"));
});
