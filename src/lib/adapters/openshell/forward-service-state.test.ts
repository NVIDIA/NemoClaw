// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildForwardServiceArgs, type ForwardServiceReceipt } from "./forward-service";
import {
  readForwardServiceReceipt,
  removeForwardServiceReceipt,
  writeForwardServiceReceipt,
} from "./forward-service-state";

const uid = process.getuid?.() ?? 0;
const target = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default" as const,
  sandboxName: "alpha",
  sandboxIdentityFingerprint: "a".repeat(64),
  localHost: "127.0.0.1" as const,
  localPort: 18_789,
  targetHost: "127.0.0.1" as const,
  targetPort: 18_789,
};
const receipt: ForwardServiceReceipt = {
  schemaVersion: 1,
  ...target,
  pid: 4242,
  uid,
  processIdentity: "linux:test-boot:100",
  hostIdentity: "linux:test-host",
  pidNamespaceIdentity: "pid:[100]",
  argv: [target.executable, ...buildForwardServiceArgs(target)],
  startedAt: "2026-08-31T16:00:00.000Z",
};

describe("OpenShell ForwardTcp receipt storage (#10691)", () => {
  let stateDirectory = "";

  beforeEach(() => {
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-service-state-"));
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { force: true, recursive: true });
  });

  it("writes and reads one owner-only process generation", () => {
    writeForwardServiceReceipt(receipt, { stateDirectory, uid });
    expect(readForwardServiceReceipt(target, { stateDirectory, uid })).toEqual(receipt);
    const filePath = path.join(stateDirectory, "forwards", "alpha-18789.json");
    expect(fs.lstatSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("rejects a receipt path that is a symbolic link", () => {
    const forwardDirectory = path.join(stateDirectory, "forwards");
    fs.mkdirSync(forwardDirectory, { mode: 0o700 });
    const outside = path.join(stateDirectory, "outside.json");
    fs.writeFileSync(outside, JSON.stringify(receipt), { mode: 0o600 });
    fs.symlinkSync(outside, path.join(forwardDirectory, "alpha-18789.json"));

    expect(() => readForwardServiceReceipt(target, { stateDirectory, uid })).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toContain(receipt.processIdentity);
  });

  it("rejects a symbolic-link state directory", () => {
    const realState = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-real-state-"));
    const linkedState = path.join(stateDirectory, "linked-state");
    fs.symlinkSync(realState, linkedState);
    try {
      expect(() =>
        writeForwardServiceReceipt(receipt, { stateDirectory: linkedState, uid }),
      ).toThrow();
    } finally {
      fs.rmSync(realState, { force: true, recursive: true });
    }
  });

  it("rejects a receipt that grants group or world access", () => {
    writeForwardServiceReceipt(receipt, { stateDirectory, uid });
    const filePath = path.join(stateDirectory, "forwards", "alpha-18789.json");
    fs.chmodSync(filePath, 0o644);
    expect(() => readForwardServiceReceipt(target, { stateDirectory, uid })).toThrow(
      /not owner-only/u,
    );
  });

  it("rejects malformed and credential-bearing receipt content", () => {
    writeForwardServiceReceipt(receipt, { stateDirectory, uid });
    const filePath = path.join(stateDirectory, "forwards", "alpha-18789.json");
    fs.writeFileSync(filePath, JSON.stringify({ ...receipt, token: "secret" }), { mode: 0o600 });
    expect(() => readForwardServiceReceipt(target, { stateDirectory, uid })).toThrow(/invalid/u);
  });

  it("removes only the classified receipt generation", () => {
    writeForwardServiceReceipt(receipt, { stateDirectory, uid });
    expect(removeForwardServiceReceipt(receipt, { stateDirectory, uid })).toBe("removed");
    expect(readForwardServiceReceipt(target, { stateDirectory, uid })).toBeNull();
    expect(removeForwardServiceReceipt(receipt, { stateDirectory, uid })).toBe("absent");
  });

  it("preserves a receipt after its process generation changes", () => {
    writeForwardServiceReceipt(receipt, { stateDirectory, uid });
    const replacement = {
      ...receipt,
      pid: 5252,
      processIdentity: "linux:test-boot:200",
    };
    writeForwardServiceReceipt(replacement, { stateDirectory, uid });
    expect(removeForwardServiceReceipt(receipt, { stateDirectory, uid })).toBe("changed");
    expect(readForwardServiceReceipt(target, { stateDirectory, uid })).toEqual(replacement);
  });
});
