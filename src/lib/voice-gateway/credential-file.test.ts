// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readPrivateBearerDescriptors } from "./credential-file";

const DEPLOYMENT_CREDENTIAL = "voice-gateway-deployment-credential-0123456789";
const OPENCLAW_CREDENTIAL = "voice-gateway-openclaw-credential-9876543210";
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-credential-"));
  directories.push(directory);
  return directory;
}

function credentialDescriptor(value: string, mode = 0o600): number {
  const file = path.join(temporaryDirectory(), "credential");
  fs.writeFileSync(file, value, { mode });
  fs.chmodSync(file, mode);
  return fs.openSync(file, fs.constants.O_RDONLY);
}

function readPair(deployment: number, openClaw: number) {
  return readPrivateBearerDescriptors({ deployment, openClaw });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("voice gateway credential descriptors", () => {
  it("reads each owner-only regular descriptor once and closes both (#9235)", () => {
    const deployment = credentialDescriptor(`${DEPLOYMENT_CREDENTIAL}\n`);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
    const read = vi.spyOn(fs, "readSync");

    expect(readPair(deployment, openClaw)).toEqual({
      deploymentCredential: DEPLOYMENT_CREDENTIAL,
      openClawCredential: OPENCLAW_CREDENTIAL,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(() => fs.fstatSync(deployment)).toThrow();
    expect(() => fs.fstatSync(openClaw)).toThrow();
  });

  it("rejects two descriptors for the same credential file and closes both (#9235)", () => {
    const deployment = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
    const deploymentStat = fs.fstatSync(deployment);
    vi.spyOn(fs, "fstatSync")
      .mockReturnValueOnce(deploymentStat)
      .mockReturnValueOnce(deploymentStat);

    expect(() => readPair(deployment, openClaw)).toThrow("different files");
    expect(() => fs.fstatSync(deployment)).toThrow();
    expect(() => fs.fstatSync(openClaw)).toThrow();
  });

  it("rejects a missing descriptor without reading the other credential (#9235)", () => {
    const deployment = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
    fs.closeSync(deployment);
    const read = vi.spyOn(fs, "readSync");

    expect(() => readPair(deployment, openClaw)).toThrow("descriptor is not open");
    expect(read).not.toHaveBeenCalled();
    expect(() => fs.fstatSync(openClaw)).toThrow();
  });

  it("rejects a non-regular descriptor before reading either credential (#9235)", () => {
    const directory = fs.openSync(temporaryDirectory(), fs.constants.O_RDONLY);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
    const read = vi.spyOn(fs, "readSync");

    expect(() => readPair(directory, openClaw)).toThrow("not a regular file");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["device", "socket", "pipe"])(
    "rejects a representative %s descriptor before reading credentials (#9235)",
    () => {
      const deployment = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
      const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
      const fstatSync = fs.fstatSync;
      vi.spyOn(fs, "fstatSync")
        .mockReturnValueOnce({ isFile: () => false } as fs.Stats)
        .mockImplementation(fstatSync);

      expect(() => readPair(deployment, openClaw)).toThrow("not a regular file");
    },
  );

  it("rejects a descriptor not owned by the current user (#9235)", () => {
    const deployment = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);

    expect(() => readPair(deployment, openClaw)).toThrow("not owned by the current user");
  });

  it.each([
    ["group-readable", DEPLOYMENT_CREDENTIAL, 0o640, "group or others"],
    ["short", "short", 0o600, "invalid size"],
    ["whitespace", `${DEPLOYMENT_CREDENTIAL} extra`, 0o600, "malformed"],
    ["oversized", "a".repeat(4098), 0o600, "invalid size"],
  ])("rejects a %s deployment credential (#9235)", (_name, value, mode, message) => {
    const deployment = credentialDescriptor(value, mode);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);

    expect(() => readPair(deployment, openClaw)).toThrow(message);
  });

  it("does not include descriptor contents in validation errors (#9235)", () => {
    const deploymentSecret = `${DEPLOYMENT_CREDENTIAL} secret`;
    const deployment = credentialDescriptor(deploymentSecret);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);

    expect(() => readPair(deployment, openClaw)).toThrowError(
      expect.objectContaining({ message: expect.not.stringContaining(deploymentSecret) }),
    );
  });

  it("preserves a credential error when descriptor cleanup also fails (#9235)", () => {
    const deployment = credentialDescriptor("short");
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
    const closeSync = fs.closeSync;
    vi.spyOn(fs, "closeSync")
      .mockImplementationOnce((descriptor) => {
        closeSync(descriptor);
        throw new Error("cleanup failed");
      })
      .mockImplementationOnce(closeSync);

    expect(() => readPair(deployment, openClaw)).toThrow("invalid size");
    expect(() => fs.fstatSync(openClaw)).toThrow();
  });

  it("reports a cleanup error after successful credential reads (#9235)", () => {
    const deployment = credentialDescriptor(DEPLOYMENT_CREDENTIAL);
    const openClaw = credentialDescriptor(OPENCLAW_CREDENTIAL);
    const closeSync = fs.closeSync;
    vi.spyOn(fs, "closeSync")
      .mockImplementationOnce((descriptor) => {
        closeSync(descriptor);
        throw new Error("cleanup failed");
      })
      .mockImplementationOnce(closeSync);

    expect(() => readPair(deployment, openClaw)).toThrow("cleanup failed");
    expect(() => fs.fstatSync(openClaw)).toThrow();
  });
});
