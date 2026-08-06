// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { snapshotCuaOpenshellExecutable } from "./openshell-authority";

const directories: string[] = [];

function fixture(contents = "#!/bin/sh\nprintf original"): {
  executable: string;
  link: string;
  digest: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-openshell-test-"));
  directories.push(directory);
  const executable = path.join(directory, "openshell-real");
  const link = path.join(directory, "openshell");
  fs.writeFileSync(executable, contents, { mode: 0o755 });
  fs.symlinkSync(executable, link);
  return {
    executable,
    link,
    digest: `sha256:${crypto.createHash("sha256").update(contents).digest("hex")}`,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CUA OpenShell executable authority", () => {
  it("snapshots the canonical symlink target and binds it to the expected digest", () => {
    const source = fixture();
    const snapshot = snapshotCuaOpenshellExecutable({
      selectedBinary: source.link,
      expectedDigest: source.digest,
    });
    directories.push(snapshot.temporaryDirectory);

    expect(snapshot.executableDigest).toBe(source.digest);
    expect(fs.realpathSync(snapshot.executable)).toBe(snapshot.executable);
    expect(fs.statSync(snapshot.executable).mode & 0o777).toBe(0o500);
  });

  it("rejects source tampering instead of executing bytes outside stored readiness", () => {
    const source = fixture();
    fs.writeFileSync(source.executable, "#!/bin/sh\nprintf replacement", { mode: 0o755 });

    expect(() =>
      snapshotCuaOpenshellExecutable({
        selectedBinary: source.link,
        expectedDigest: source.digest,
      }),
    ).toThrow("does not match its expected digest");
  });
});
