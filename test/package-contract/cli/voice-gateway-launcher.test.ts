// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { buildVoiceGatewayLaunchContract } from "../../../dist/lib/voice-gateway/launcher";
import { runVoiceGatewayLaunch } from "../../../dist/lib/actions/voice-gateway/launch";
import {
  openFileTargets,
  requestSession,
  reserveLoopbackPort,
  stopGateway,
  waitForGatewayListening,
} from "../../fixtures/voice-gateway/process-launcher";

const DEPLOYMENT_BEARER = "deployment-bearer-for-process-contract";
const ROTATED_DEPLOYMENT_BEARER = "rotated-deployment-bearer-for-process-contract";
const OPENCLAW_CREDENTIAL = "openclaw-bearer-for-process-contract";
const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopGateway(child)));
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("voice gateway process launch contract", () => {
  it("maps fixed descriptors, closes them before serving, and rotates on restart (#9235)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-process-"));
    directories.push(directory);
    const deploymentCredentialPath = path.join(directory, "deployment");
    const openClawCredentialPath = path.join(directory, "openclaw");
    fs.writeFileSync(deploymentCredentialPath, DEPLOYMENT_BEARER, { mode: 0o600 });
    fs.writeFileSync(openClawCredentialPath, OPENCLAW_CREDENTIAL, { mode: 0o600 });
    const listenPort = await reserveLoopbackPort();
    const options = {
      deploymentCredentialPath,
      openClawCredentialPath,
      gatewayUrl: "ws://127.0.0.1:18789/ws",
      runtimeIdentity: "voiceclaw-local",
      runtimeProfile: "voiceclaw-pinned",
      sandbox: "repository-fixture",
      agent: "main",
      listenPort,
    };
    const contract = buildVoiceGatewayLaunchContract(options);

    expect(JSON.stringify(contract)).not.toContain(deploymentCredentialPath);
    expect(JSON.stringify(contract)).not.toContain(openClawCredentialPath);
    expect(JSON.stringify(contract)).not.toContain(DEPLOYMENT_BEARER);
    expect(JSON.stringify(contract)).not.toContain(OPENCLAW_CREDENTIAL);

    const first = await runVoiceGatewayLaunch(options);
    children.push(first);
    await waitForGatewayListening(first);
    expect(openFileTargets(first.pid!)).not.toContain(deploymentCredentialPath);
    expect(openFileTargets(first.pid!)).not.toContain(openClawCredentialPath);
    expect(await requestSession(listenPort, DEPLOYMENT_BEARER)).toMatchObject({ status: 201 });
    await stopGateway(first);

    fs.writeFileSync(deploymentCredentialPath, ROTATED_DEPLOYMENT_BEARER, { mode: 0o600 });
    const second = await runVoiceGatewayLaunch(options);
    children.push(second);
    await waitForGatewayListening(second);
    expect(openFileTargets(second.pid!)).not.toContain(deploymentCredentialPath);
    expect(openFileTargets(second.pid!)).not.toContain(openClawCredentialPath);
    expect(await requestSession(listenPort, DEPLOYMENT_BEARER)).toEqual({
      status: 401,
      body: '{"error":"authentication_failed"}',
    });
    expect(await requestSession(listenPort, ROTATED_DEPLOYMENT_BEARER)).toMatchObject({
      status: 201,
    });
    await stopGateway(second);
  });
});
