// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decodeHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_ROUTING_ENV,
} from "../../hermes-switchyard-routing";
import { resolveOnboardOptions, runOnboardCommand } from "../command";
import type { OnboardFlags } from "../command-support";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("Switchyard onboarding command", () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-switchyard-"));
    configPath = path.join(root, "switchyard.json");
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        efficient: { provider: "nvidia-prod", model: "nvidia/nemotron-nano" },
        capable: { provider: "openai-api", model: "gpt-5.2" },
      })}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  const resolve = (
    flags: OnboardFlags,
    overrides: Partial<Parameters<typeof resolveOnboardOptions>[1]> = {},
  ) =>
    resolveOnboardOptions(flags, {
      env: {},
      error: () => {},
      exit: exitWithCode,
      ...overrides,
    });

  it("accepts a high-level config for managed Hermes onboarding (#13862)", () => {
    expect(
      resolve(
        { agent: "hermes", "switchyard-config": configPath },
        { listAgents: () => ["openclaw", "hermes"] },
      ).switchyardRouting,
    ).toMatchObject({
      routeId: "switchyard",
      judge: { mode: "reuse-capable", target: "capable" },
    });
  });

  it.each([
    ["another agent", { agent: "openclaw" }, "supported only for Hermes"],
    ["a custom Dockerfile", { agent: "hermes", from: "Custom.Dockerfile" }, "managed Hermes image"],
    [
      "an external image",
      {
        agent: "hermes",
        "from-image": `ghcr.io/example/hermes@sha256:${"a".repeat(64)}`,
      },
      "managed Hermes image",
    ],
    [
      "the Portable profile",
      { agent: "hermes", "experimental-profile": "portable" },
      "not supported by the Portable profile",
    ],
  ] as const)("rejects Switchyard routing with %s (#13862)", (_name, flags, expectedError) => {
    const errors: string[] = [];

    expect(() =>
      resolve({ ...flags, "switchyard-config": configPath } as OnboardFlags, {
        listAgents: () => ["openclaw", "hermes"],
        error: (message = "") => errors.push(message),
      }),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain(expectedError);
  });

  it("rejects Switchyard routing while resuming a Portable checkpoint (#13862)", () => {
    const errors: string[] = [];

    expect(() =>
      resolve(
        { agent: "hermes", resume: true, "switchyard-config": configPath },
        {
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
          resumeIntent: {
            effectiveResume: true,
            snapshot: {
              fingerprint: "a".repeat(64),
              sessionId: "session-1",
              checkpointUpdatedAt: "2026-08-13T00:00:00.000Z",
              machineRevision: 1,
              profile: "portable",
              recordedAgent: "hermes",
              recordedCustomImage: false,
            },
          },
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("not supported by the Portable profile");
  });

  it("accepts a managed Hermes checkpoint as the durable agent selection (#13862)", () => {
    expect(
      resolve(
        { resume: true, "switchyard-config": configPath },
        {
          listAgents: () => ["openclaw", "hermes"],
          resumeIntent: {
            effectiveResume: true,
            snapshot: {
              fingerprint: "a".repeat(64),
              sessionId: "session-1",
              checkpointUpdatedAt: "2026-08-13T00:00:00.000Z",
              machineRevision: 1,
              profile: "default",
              recordedAgent: "hermes",
              recordedCustomImage: false,
            },
          },
        },
      ).switchyardRouting,
    ).toMatchObject({ routeId: "switchyard" });
  });

  it("rejects a resumed Hermes checkpoint recorded from a custom image (#13862)", () => {
    const errors: string[] = [];

    expect(() =>
      resolve(
        { resume: true, "switchyard-config": configPath },
        {
          listAgents: () => ["openclaw", "hermes"],
          error: (message = "") => errors.push(message),
          resumeIntent: {
            effectiveResume: true,
            snapshot: {
              fingerprint: "a".repeat(64),
              sessionId: "session-1",
              checkpointUpdatedAt: "2026-08-13T00:00:00.000Z",
              machineRevision: 1,
              profile: "default",
              recordedAgent: "hermes",
              recordedCustomImage: true,
            },
          },
        },
      ),
    ).toThrow("exit:1");
    expect(errors.join("\n")).toContain("requires the managed Hermes image");
  });

  it("scopes canonical routing intent to one nemohermes onboarding run (#13862)", async () => {
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_AGENT: "hermes",
      [HERMES_SWITCHYARD_ROUTING_ENV]: "previous-value",
    };

    await runOnboardCommand({
      flags: { "switchyard-config": configPath },
      env,
      listAgents: () => ["openclaw", "hermes"],
      runOnboard: async (options) => {
        expect(options.switchyardRouting?.routeId).toBe("switchyard");
        expect(
          decodeHermesSwitchyardRoutingIntent(env[HERMES_SWITCHYARD_ROUTING_ENV]!).judge,
        ).toEqual({ mode: "reuse-capable", target: "capable" });
      },
    });
    expect(env[HERMES_SWITCHYARD_ROUTING_ENV]).toBe("previous-value");
  });

  it("does not let ambient internal routing transport activate the feature (#13862)", async () => {
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_AGENT: "hermes",
      [HERMES_SWITCHYARD_ROUTING_ENV]: "ambient-value",
    };

    await runOnboardCommand({
      flags: {},
      env,
      listAgents: () => ["openclaw", "hermes"],
      runOnboard: async (options) => {
        expect(options.switchyardRouting).toBeUndefined();
        expect(env[HERMES_SWITCHYARD_ROUTING_ENV]).toBeUndefined();
      },
    });
    expect(env[HERMES_SWITCHYARD_ROUTING_ENV]).toBe("ambient-value");
  });
});
