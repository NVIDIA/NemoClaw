// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const helper = process.env.NEMOCLAW_GATEWAY_PROCESS_CONTROL;
const options = { skip: !helper || process.platform !== "win32", timeout: 25_000 };

function fixture(args: string[], configure?: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-owner-"));
  const stop = path.join(root, "stop");
  const receipt = path.join(root, "stopped.json");
  const nonce = randomBytes(24).toString("hex");
  configure?.(root);
  const child = spawn(helper!, ["--owner", helper!, stop, receipt, nonce, ...args], {
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    root,
    stop,
    receipt,
    nonce,
    child,
    closed,
    output: () => output,
    async waitReady() {
      const deadline = Date.now() + 5000;
      while (!output.includes("DESCENDANT ") && Date.now() < deadline && child.exitCode === null)
        await delay(20);
      assert.match(output, /DESCENDANT [0-9]+/u);
      assert.equal(errors, "");
    },
    async finish() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertDrained(value: ReturnType<typeof fixture>, requested: boolean, code: number) {
  const receipt = JSON.parse(fs.readFileSync(value.receipt, "utf8"));
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    nonce: value.nonce,
    activeProcesses: 0,
    stopped: true,
    requested,
    gatewayExitCode: code,
  });
  for (const match of value.output().matchAll(/(?:PARENT|DESCENDANT) ([0-9]+)/gu))
    assert.throws(() => process.kill(Number(match[1]), 0), { code: "ESRCH" });
}

test("gateway owner drains descendants on a nonce-bound stop request", options, async () => {
  const value = fixture(["--parent", "wait"]);
  try {
    await value.waitReady();
    fs.writeFileSync(value.stop + ".pending", value.nonce, { flag: "wx" });
    fs.linkSync(value.stop + ".pending", value.stop);
    assert.equal(await value.closed, 0);
    assertDrained(value, true, 0);
  } finally {
    await value.finish();
  }
});

test(
  "gateway owner drains descendants after gateway exit and preserves its exit code",
  options,
  async () => {
    const value = fixture(["--parent", "exit"]);
    try {
      assert.equal(await value.closed, 7);
      assertDrained(value, false, 7);
    } finally {
      await value.finish();
    }
  },
);

test("killed gateway owner kills its job but cannot claim verified cleanup", options, async () => {
  const value = fixture(["--parent", "wait"]);
  try {
    await value.waitReady();
    value.child.kill();
    await value.closed;
    assert(!fs.existsSync(value.receipt));
    for (const match of value.output().matchAll(/(?:PARENT|DESCENDANT) ([0-9]+)/gu))
      assert.throws(() => process.kill(Number(match[1]), 0), { code: "ESRCH" });
  } finally {
    await value.finish();
  }
});

test(
  "gateway owner rejects an invalid stop nonce and leaves no success receipt",
  options,
  async () => {
    const value = fixture(["--parent", "wait"]);
    try {
      await value.waitReady();
      fs.writeFileSync(value.stop, "0".repeat(48), { flag: "wx" });
      assert.equal(await value.closed, 2);
      assert(!fs.existsSync(value.receipt));
    } finally {
      await value.finish();
    }
  },
);

test("gateway owner preserves existing receipt without launching a process", options, async () => {
  const value = fixture(["--parent", "wait"], (root) =>
    fs.writeFileSync(path.join(root, "stopped.json"), "existing-content", { flag: "wx" }),
  );
  try {
    assert.equal(await value.closed, 2);
    assert.equal(value.output(), "");
    assert.equal(fs.readFileSync(value.receipt, "utf8"), "existing-content");
  } finally {
    await value.finish();
  }
});

test("gateway owner preserves exact argument boundaries", options, async () => {
  const args = [
    "",
    "two words",
    'embedded"quote',
    "C:\\path with space\\",
    '\\"',
    "line\nbreak",
    "&|<>%",
  ];
  const value = fixture(["--echo", ...args]);
  try {
    assert.equal(await value.closed, 0);
    assert.deepEqual(JSON.parse(value.output()), args);
    assertDrained(value, false, 0);
  } finally {
    await value.finish();
  }
});
