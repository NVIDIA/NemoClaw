// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildVoiceGatewayLaunchContract, launchVoiceGateway } from "./launcher";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-launcher-"));
  directories.push(directory);
  return directory;
}

function options() {
  const directory = temporaryDirectory();
  return {
    deploymentCredentialPath: path.join(directory, "deployment"),
    openClawCredentialPath: path.join(directory, "openclaw"),
    gatewayUrl: "ws://127.0.0.1:18789/ws",
    runtimeIdentity: "voiceclaw-local",
    runtimeProfile: "voiceclaw-pinned",
    sandbox: "repository-fixture",
    agent: "main",
    listenPort: 18800,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("voice gateway launcher", () => {
  it("keeps credential source paths and values out of the child contract (#9235)", () => {
    const launchOptions = options();
    const contract = buildVoiceGatewayLaunchContract(launchOptions);

    expect(contract.args).not.toContain(launchOptions.deploymentCredentialPath);
    expect(contract.args).not.toContain(launchOptions.openClawCredentialPath);
    expect(contract.env).toEqual({ NEMOCLAW_EXPERIMENTAL_VOICE_GATEWAY: "1" });
  });

  it("rejects a symbolic-link credential source before launch (#9235)", () => {
    const launchOptions = options();
    const target = path.join(path.dirname(launchOptions.deploymentCredentialPath), "target");
    fs.writeFileSync(target, "deployment-credential-for-launcher-012345", { mode: 0o600 });
    fs.symlinkSync(target, launchOptions.deploymentCredentialPath);
    fs.writeFileSync(
      launchOptions.openClawCredentialPath,
      "openclaw-credential-for-launcher-01234567",
      { mode: 0o600 },
    );

    expect(() => launchVoiceGateway(launchOptions)).toThrow("symbolic link");
    expect(() => launchVoiceGateway(launchOptions)).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(launchOptions.deploymentCredentialPath),
      }),
    );
  });
});
