// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentDefinition } from "../../../agent/definition-types";
import {
  cleanupPrivateHermesManifestAgent,
  privateHermesManifestAgent,
} from "./hermes-manifest-agent";

const temporaryDirectories: string[] = [];

afterEach(() => {
  cleanupPrivateHermesManifestAgent();
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("privateHermesManifestAgent", () => {
  it("returns the current definition on a cache hit while keeping the private manifest path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-manifest-agent-cache-"));
    temporaryDirectories.push(directory);
    const manifestPath = path.join(directory, "manifest.yaml");
    fs.writeFileSync(manifestPath, 'expected_version: "0.21.3"\n', { mode: 0o600 });

    const first = privateHermesManifestAgent({ manifestPath } as AgentDefinition);
    expect(first.manifestPath).not.toBe(manifestPath);

    const changed = { manifestPath, expected_version: "0.20.6" } as AgentDefinition;
    const second = privateHermesManifestAgent(changed);

    expect(second.expected_version).toBe("0.20.6");
    expect(second.manifestPath).toBe(first.manifestPath);
    expect(fs.readFileSync(second.manifestPath, "utf8")).toBe(
      'expected_version: "0.21.3"\n',
    );
  });
});
