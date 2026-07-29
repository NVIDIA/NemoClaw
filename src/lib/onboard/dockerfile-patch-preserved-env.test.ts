// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { encodePreservedEnvFiles, PRESERVED_ENV_REBUILD_KEY } from "../state/preserved-env/index";
import { patchStagedDockerfile } from "./dockerfile-patch";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preserved-env-patch-"));
  delete process.env.NEMOCLAW_MESSAGING_PLAN_B64;
  delete process.env[PRESERVED_ENV_REBUILD_KEY];
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.NEMOCLAW_MESSAGING_PLAN_B64;
  delete process.env[PRESERVED_ENV_REBUILD_KEY];
});

it("adds preserved Hermes home channels to the image messaging plan (#7803)", () => {
  const plan = {
    schemaVersion: 1,
    sandboxName: "my-assistant",
    agent: "hermes",
    workflow: "rebuild",
    channels: [
      {
        channelId: "slack",
        displayName: "Slack",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [
      {
        channelId: "slack",
        renderId: "slack-hermes-env",
        kind: "env-lines",
        agent: "hermes",
        target: "~/.hermes/.env",
        lines: ["SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN"],
        templateRefs: [],
      },
    ],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
  process.env.NEMOCLAW_MESSAGING_PLAN_B64 = Buffer.from(JSON.stringify(plan), "utf8").toString(
    "base64",
  );
  process.env[PRESERVED_ENV_REBUILD_KEY] = encodePreservedEnvFiles([
    {
      path: ".env",
      assignments: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID="],
    },
  ]);
  const dockerfilePath = path.join(tmpRoot, "Dockerfile");
  fs.writeFileSync(
    dockerfilePath,
    [
      "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
      "ARG NEMOCLAW_MODEL=old",
      "ARG NEMOCLAW_PROVIDER_KEY=old",
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
      "ARG CHAT_UI_URL=old",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
      "ARG NEMOCLAW_INFERENCE_API=old",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
      "ARG NEMOCLAW_BUILD_ID=old",
      "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      "ARG NEMOCLAW_PROXY_HOST=old",
      "ARG NEMOCLAW_PROXY_PORT=old",
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0",
      "ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0",
      "ARG NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE=operator",
      "ARG NEMOCLAW_MESSAGING_PLAN_B64=old",
    ].join("\n"),
    "utf8",
  );

  patchStagedDockerfile(
    dockerfilePath,
    "custom-model",
    "https://chat.example",
    "build-1",
    "compatible-endpoint",
    null,
    null,
    null,
    false,
    null,
    [],
  );

  const planArg = fs
    .readFileSync(dockerfilePath, "utf8")
    .split("\n")
    .find((line) => line.startsWith("ARG NEMOCLAW_MESSAGING_PLAN_B64="));
  expect(planArg).toBeDefined();
  const patchedPlan = JSON.parse(
    Buffer.from(planArg!.split("=")[1] ?? "", "base64").toString("utf8"),
  ) as {
    agentRender: Array<{ renderId?: string; lines?: string[] }>;
  };
  expect(patchedPlan.agentRender[0]).toMatchObject({
    renderId: "hermes-preserved-home-channels",
    lines: ["SLACK_HOME_CHANNEL=C0123", "SLACK_HOME_CHANNEL_THREAD_ID="],
  });
});
