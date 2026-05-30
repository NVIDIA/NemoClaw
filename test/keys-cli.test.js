// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function runWithCredentialFile(args, credentialFile) {
  try {
    const out = execSync(`node "${CLI}" ${args}`, {
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_CREDENTIALS_FILE: credentialFile,
      },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("CLI key keeper", () => {
  it("lists no credentials when key keeper is empty", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-keys-empty-"));
    const result = runWithCredentialFile("keys list", path.join(home, "credentials.json"));
    expect(result.code).toBe(0);
    expect(result.out).toContain("No credentials stored yet.");
  });

  it("sets, lists, and removes a stored key", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-keys-set-remove-"));

    const credentialFile = path.join(home, "credentials.json");

    const setResult = runWithCredentialFile(
      "keys set NVIDIA_API_KEY --value nvapi-abc123",
      credentialFile,
    );
    expect(setResult.code).toBe(0);
    expect(setResult.out).toContain("Saved NVIDIA_API_KEY");

    const listResult = runWithCredentialFile("keys list", credentialFile);
    expect(listResult.code).toBe(0);
    expect(listResult.out).toContain("NVIDIA_API_KEY");

    const removeResult = runWithCredentialFile("keys remove NVIDIA_API_KEY", credentialFile);
    expect(removeResult.code).toBe(0);
    expect(removeResult.out).toContain("Removed NVIDIA_API_KEY");

    const postListResult = runWithCredentialFile("keys list", credentialFile);
    expect(postListResult.code).toBe(0);
    expect(postListResult.out).toContain("No credentials stored yet.");
  });
});
