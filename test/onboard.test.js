// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSandboxConfigSyncScript,
  getFutureShellPathHint,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
  writeSandboxConfigSyncFile,
} from "../bin/lib/onboard";

describe("onboard helpers", () => {
  it("builds a sandbox sync script that only writes nemoclaw config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    // Writes NemoClaw selection config to writable ~/.nemoclaw/
    expect(script).toMatch(/cat > ~\/\.nemoclaw\/config\.json/);
    expect(script).toMatch(/"model": "nemotron-3-nano:30b"/);
    expect(script).toMatch(/"credentialEnv": "OPENAI_API_KEY"/);

    // Must NOT modify openclaw config from inside the sandbox — model routing
    // is handled by the host-side gateway (openshell inference set)
    expect(script).not.toMatch(/openclaw\.json/);
    expect(script).not.toMatch(/openclaw models set/);

    expect(script).toMatch(/^exit$/m);
  });

  it("pins the gateway image to the installed OpenShell release version", () => {
    expect(getInstalledOpenshellVersion("openshell 0.0.12")).toBe("0.0.12");
    expect(getInstalledOpenshellVersion("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("0.0.13");
    expect(getInstalledOpenshellVersion("bogus")).toBe(null);
    expect(getStableGatewayImageRef("openshell 0.0.12")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.12");
    expect(getStableGatewayImageRef("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.13");
    expect(getStableGatewayImageRef("bogus")).toBe(null);
  });

  it("returns a future-shell PATH hint for user-local openshell installs", () => {
    expect(getFutureShellPathHint("/home/test/.local/bin", "/usr/local/bin:/usr/bin")).toBe(
      'export PATH="/home/test/.local/bin:$PATH"'
    );
  });

  it("skips the future-shell PATH hint when the bin dir is already on PATH", () => {
    expect(
      getFutureShellPathHint("/home/test/.local/bin", "/home/test/.local/bin:/usr/local/bin:/usr/bin")
    ).toBe(null);
  });

  it("writes sandbox sync scripts to a temp file for stdin redirection", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-test-"));
    try {
      const scriptFile = writeSandboxConfigSyncFile("echo test", tmpDir, 1234);
      expect(scriptFile).toBe(path.join(tmpDir, "nemoclaw-sync-1234.sh"));
      expect(fs.readFileSync(scriptFile, "utf8")).toBe("echo test\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
