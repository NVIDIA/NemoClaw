// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquireMxcWindowsOpenShellPins,
  MxcWindowsOpenShellExecutorError,
} from "../src/lib/onboard/runtime-provider/mxc-windows-openshell-executor";

type NativePinFixture = {
  directory: string;
  file: string;
  content: string;
  sha256: string;
  request: { directories: string[]; files: { path: string; sha256: string }[] };
  acquire: () => ReturnType<typeof acquireMxcWindowsOpenShellPins>;
  release: () => Promise<void>;
};

const pinTest = it.extend<{ pins: NativePinFixture }>({
  pins: async ({}, use) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-pins-"));
    const file = path.join(directory, "fixture.txt");
    const content = "private fixture content";
    const sha256 = createHash("sha256").update(content).digest("hex");
    const request = { directories: [directory], files: [{ path: file, sha256 }] };
    let lease: Awaited<ReturnType<typeof acquireMxcWindowsOpenShellPins>> | undefined;
    try {
      fs.writeFileSync(file, content);
      await use({
        directory,
        file,
        content,
        sha256,
        request,
        acquire: async () => {
          lease = await acquireMxcWindowsOpenShellPins(request);
          return lease;
        },
        release: async () => {
          await lease?.release();
          lease = undefined;
        },
      });
    } finally {
      try {
        await lease?.release();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  },
});

describe.skipIf(process.platform !== "win32")("Windows MXC native file pins", () => {
  pinTest(
    "blocks writes until the native pin is released",
    async ({ pins }) => {
      const lease = await pins.acquire();
      expect(lease.isActive()).toBe(true);
      expect(() => fs.writeFileSync(pins.file, "replacement")).toThrow();
      expect(fs.readFileSync(pins.file, "utf8")).toBe(pins.content);
      await pins.release();
      fs.writeFileSync(pins.file, "released");
      expect(fs.readFileSync(pins.file, "utf8")).toBe("released");
    },
    90_000,
  );

  pinTest.for([
    {
      scenario: "digest-drift",
      verification: { stage: "pin-file", errorClass: "identity-drift" },
      prepare(pins: NativePinFixture) {
        pins.request.files[0]!.sha256 = "0".repeat(64);
        return () => undefined;
      },
    },
    {
      scenario: "sharing-conflict",
      verification: { stage: "pin-file", errorClass: "boundary-error", nativeErrorCode: 32 },
      prepare(pins: NativePinFixture) {
        const writer = fs.openSync(pins.file, "r+");
        return () => fs.closeSync(writer);
      },
    },
  ])(
    "reports $scenario without raw errors and permits recovery",
    { timeout: 90_000 },
    async ({ verification, prepare }, { pins }) => {
      const closeWriter = prepare(pins);
      try {
        const error = await pins.acquire().catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(MxcWindowsOpenShellExecutorError);
        expect(error).toMatchObject({ mutationState: "not-started", verification });
        expect(JSON.stringify(error)).not.toContain(pins.directory);
        expect(JSON.stringify(error)).not.toContain(pins.content);
      } finally {
        closeWriter();
      }
      pins.request.files[0]!.sha256 = pins.sha256;
      const lease = await pins.acquire();
      expect(lease.isActive()).toBe(true);
      await pins.release();
      fs.writeFileSync(pins.file, "released");
      expect(fs.readFileSync(pins.file, "utf8")).toBe("released");
    },
  );
});
