// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildVoiceGatewayLaunchContract } from "../../../dist/lib/voice-gateway/launcher";
import { runVoiceGatewayLaunch } from "../../../dist/lib/actions/voice-gateway/launch";
import {
  openFileTargets,
  requestSession,
  reserveLoopbackPort,
  stopGateway,
  VOICE_GATEWAY_PROCESS_CONTRACT_TIMEOUT_MS,
  waitForGatewayListening,
} from "../../fixtures/voice-gateway/process-launcher";
import { describe, expect, test } from "../../helpers/owned-test-resources";

const DEPLOYMENT_BEARER = "deployment-bearer-for-process-contract";
const ROTATED_DEPLOYMENT_BEARER = "rotated-deployment-bearer-for-process-contract";
const OPENCLAW_CREDENTIAL = "openclaw-bearer-for-process-contract";
describe("voice gateway process launch contract", () => {
  test(
    "maps fixed descriptors, closes them before serving, and rotates on restart (#9235)",
    async ({ resources }) => {
      const directory = resources.temporaryDirectory("nemoclaw-voice-process-");
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

      const first = resources.ownChild(await runVoiceGatewayLaunch(options));
      await waitForGatewayListening(first);
      expect(openFileTargets(first.pid!)).not.toContain(deploymentCredentialPath);
      expect(openFileTargets(first.pid!)).not.toContain(openClawCredentialPath);
      expect(await requestSession(listenPort, DEPLOYMENT_BEARER)).toMatchObject({ status: 201 });
      await stopGateway(first);

      fs.writeFileSync(deploymentCredentialPath, ROTATED_DEPLOYMENT_BEARER, { mode: 0o600 });
      const second = resources.ownChild(await runVoiceGatewayLaunch(options));
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
    },
    VOICE_GATEWAY_PROCESS_CONTRACT_TIMEOUT_MS,
  );
});
