// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadUserLocalOllamaOwnership,
  recordUserLocalOllamaOwnership,
  removeUserLocalOllamaOwnership,
  userLocalOllamaOwnershipInternals,
} from "./ollama-user-local-runtime";

const temporaryDirectories: string[] = [];

function createFixture(): { homeDir: string; stateDir: string; binPath: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-owner-"));
  temporaryDirectories.push(homeDir);
  return {
    homeDir,
    stateDir: path.join(homeDir, ".nemoclaw"),
    binPath: path.join(homeDir, ".local", "bin", "ollama"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("user-local Ollama ownership receipt", () => {
  it("records and reloads only the fixed NemoClaw user-local path (#8502)", () => {
    const fixture = createFixture();

    recordUserLocalOllamaOwnership(fixture.binPath, fixture);

    expect(loadUserLocalOllamaOwnership(fixture)).toBe(fixture.binPath);
    const receipt = userLocalOllamaOwnershipInternals.receiptPath(fixture);
    expect(fs.statSync(receipt).mode & 0o777).toBe(0o600);
  });

  it("refuses to record an Ollama path outside the fixed user-local install (#8502)", () => {
    const fixture = createFixture();

    expect(() => recordUserLocalOllamaOwnership("/usr/local/bin/ollama", fixture)).toThrow(
      "unexpected user-local Ollama path",
    );
  });

  it("rejects a receipt that redirects recovery to another executable (#8502)", () => {
    const fixture = createFixture();
    const receipt = userLocalOllamaOwnershipInternals.receiptPath(fixture);
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(
      receipt,
      `${JSON.stringify({ schemaVersion: 1, binPath: "/tmp/unrelated" })}\n`,
      { mode: 0o600 },
    );

    expect(() => loadUserLocalOllamaOwnership(fixture)).toThrow("ownership receipt is invalid");
  });

  it("removes obsolete ownership after a system installation (#8502)", () => {
    const fixture = createFixture();
    recordUserLocalOllamaOwnership(fixture.binPath, fixture);

    removeUserLocalOllamaOwnership(fixture);

    expect(loadUserLocalOllamaOwnership(fixture)).toBeNull();
  });
});
