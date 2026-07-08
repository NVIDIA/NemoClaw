// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import {
  readPrivateRegularFile,
  writePrivateRegularFile,
} from "../tools/e2e-advisor/private-file.ts";

describe("private E2E controller files", () => {
  it("writes private regular files without following links or truncating hardlink targets", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-file-"));
    const regular = path.join(directory, "regular.json");
    const target = path.join(directory, "target.json");
    const symlink = path.join(directory, "symlink.json");
    const hardlink = path.join(directory, "hardlink.json");
    try {
      writePrivateRegularFile(regular, "regular\n");
      expect(readPrivateRegularFile(regular, { maxBytes: 64 })).toBe("regular\n");
      expect(fs.statSync(regular).mode & 0o777).toBe(0o600);
      writePrivateRegularFile(regular, "updated\n");
      expect(readPrivateRegularFile(regular, { maxBytes: 64 })).toBe("updated\n");

      fs.writeFileSync(target, "protected\n");
      fs.symlinkSync(target, symlink);
      fs.linkSync(target, hardlink);

      expect(() => writePrivateRegularFile(symlink, "replaced\n")).toThrow();
      expect(() => writePrivateRegularFile(hardlink, "replaced\n")).toThrow(/private regular/u);
      expect(fs.readFileSync(target, "utf8")).toBe("protected\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects FIFO paths without blocking", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-fifo-"));
    const fifo = path.join(directory, "state.json");
    try {
      execFileSync("mkfifo", [fifo]);
      const moduleUrl = pathToFileURL(path.resolve("tools/e2e-advisor/private-file.ts")).href;
      const read = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `import { readPrivateRegularFile } from ${JSON.stringify(moduleUrl)}; readPrivateRegularFile(${JSON.stringify(fifo)}, { maxBytes: 64 });`,
        ],
        { encoding: "utf8", timeout: 2_000 },
      );
      const write = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `import { writePrivateRegularFile } from ${JSON.stringify(moduleUrl)}; writePrivateRegularFile(${JSON.stringify(fifo)}, "replaced\\n");`,
        ],
        { encoding: "utf8", timeout: 2_000 },
      );

      expect(read.error).toBeUndefined();
      expect(read.status).not.toBe(0);
      expect(write.error).toBeUndefined();
      expect(write.status).not.toBe(0);
      expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
