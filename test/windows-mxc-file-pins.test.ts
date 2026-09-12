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

describe.skipIf(process.platform !== "win32")("Windows MXC native file pins", () => {
  it.each(["valid", "digest-drift", "sharing-conflict"] as const)(
    "preserves native pin enforcement and reports %s without raw errors",
    async (scenario) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-pins-"));
      const file = path.join(directory, "fixture.txt");
      const content = "private fixture content";
      const sha256 = createHash("sha256").update(content).digest("hex");
      fs.writeFileSync(file, content);
      const request = { directories: [directory], files: [{ path: file, sha256 }] };
      let writer: number | undefined;
      let lease: Awaited<ReturnType<typeof acquireMxcWindowsOpenShellPins>> | undefined;
      try {
        if (scenario === "digest-drift") request.files[0]!.sha256 = "0".repeat(64);
        if (scenario === "sharing-conflict") writer = fs.openSync(file, "r+");
        if (scenario === "valid") {
          lease = await acquireMxcWindowsOpenShellPins(request);
          expect(lease.isActive()).toBe(true);
          expect(() => fs.writeFileSync(file, "replacement")).toThrow();
          expect(fs.readFileSync(file, "utf8")).toBe(content);
        } else {
          const error = await acquireMxcWindowsOpenShellPins(request)
            .then((value) => {
              lease = value;
              return value;
            })
            .catch((failure: unknown) => failure);
          expect(error).toBeInstanceOf(MxcWindowsOpenShellExecutorError);
          expect(error).toMatchObject({
            mutationState: "not-started",
            verification:
              scenario === "digest-drift"
                ? { stage: "pin-file", errorClass: "identity-drift" }
                : { stage: "pin-file", errorClass: "boundary-error", nativeErrorCode: 32 },
          });
          expect(JSON.stringify(error)).not.toContain(directory);
          expect(JSON.stringify(error)).not.toContain(content);
          if (writer !== undefined) {
            fs.closeSync(writer);
            writer = undefined;
          }
          request.files[0]!.sha256 = sha256;
          lease = await acquireMxcWindowsOpenShellPins(request);
          expect(lease.isActive()).toBe(true);
        }
        await lease.release();
        lease = undefined;
        fs.writeFileSync(file, "released");
        expect(fs.readFileSync(file, "utf8")).toBe("released");
      } finally {
        if (writer !== undefined) fs.closeSync(writer);
        await lease?.release();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
