// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.unstubAllEnvs();
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

  it("rejects a receipt that is not valid JSON (#8502)", () => {
    const fixture = createFixture();
    const receipt = userLocalOllamaOwnershipInternals.receiptPath(fixture);
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, "{not json", { mode: 0o600 });

    expect(() => loadUserLocalOllamaOwnership(fixture)).toThrow("ownership receipt is malformed");
  });

  it("refuses a receipt path that is a symbolic link (#8502)", () => {
    const fixture = createFixture();
    const receipt = userLocalOllamaOwnershipInternals.receiptPath(fixture);
    const plantedReceipt = path.join(fixture.homeDir, "planted-receipt.json");
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(
      plantedReceipt,
      `${JSON.stringify({ schemaVersion: 1, binPath: fixture.binPath })}\n`,
      { mode: 0o600 },
    );
    fs.symlinkSync(plantedReceipt, receipt);

    expect(() => loadUserLocalOllamaOwnership(fixture)).toThrow();
  });

  it("refuses a symbolic-link receipt directory before loading or removing (#8502)", () => {
    const fixture = createFixture();
    const receiptDirectory = path.dirname(userLocalOllamaOwnershipInternals.receiptPath(fixture));
    const plantedDirectory = path.join(fixture.homeDir, "planted-ollama-state");
    fs.mkdirSync(path.dirname(receiptDirectory), { recursive: true });
    fs.mkdirSync(plantedDirectory, { mode: 0o700 });
    fs.symlinkSync(plantedDirectory, receiptDirectory);
    vi.stubEnv("HOME", fixture.homeDir);

    expect(() => loadUserLocalOllamaOwnership(fixture)).toThrow("is a symbolic link");
    expect(() => removeUserLocalOllamaOwnership(fixture)).toThrow("is a symbolic link");
  });

  it("removes obsolete ownership after a system installation (#8502)", () => {
    const fixture = createFixture();
    recordUserLocalOllamaOwnership(fixture.binPath, fixture);

    removeUserLocalOllamaOwnership(fixture);

    expect(loadUserLocalOllamaOwnership(fixture)).toBeNull();
  });
});
