// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../src/lib/messaging/channels";
import { ManifestCompiler } from "../src/lib/messaging/compiler/manifest-compiler";
import { createBuiltInMessagingHookRegistry } from "../src/lib/messaging/hooks";

const TEST_CREDENTIALS: Readonly<Record<string, string>> = {
  MSTEAMS_APP_PASSWORD: "test-teams-client-secret",
};
const TEST_TEAMS_ENV = {
  MSTEAMS_APP_ID: "test-teams-app-id",
  MSTEAMS_TENANT_ID: "test-teams-tenant-id",
  TEAMS_ALLOWED_USERS: "00000000-0000-0000-0000-000000000001",
  MSTEAMS_PORT: "3978",
} as const;

function compiler(): ManifestCompiler {
  return new ManifestCompiler(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        env: {},
        getCredential: (key) => TEST_CREDENTIALS[key] ?? null,
        saveCredential: () => {},
        prompt: async () => "",
        log: () => {},
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
}

function setEnvValue(key: string, value: string | undefined): void {
  value === undefined ? Reflect.deleteProperty(process.env, key) : (process.env[key] = value);
}

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      setEnvValue(key, value);
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      setEnvValue(key, value);
    }
  }
}

describe("ManifestCompiler Microsoft Teams channel", () => {
  it("rejects unsafe Microsoft Teams Hermes env render values", async () => {
    const cases: Array<readonly [string, string]> = [
      ["MSTEAMS_APP_ID", "teams-app\nEVIL=1"],
      ["MSTEAMS_TENANT_ID", "teams-tenant\nEVIL=1"],
      ["TEAMS_ALLOWED_USERS", "user-one\nEVIL=1"],
    ];

    for (const [envKey, value] of cases) {
      await expect(
        withEnv(
          {
            ...TEST_TEAMS_ENV,
            [envKey]: value,
          },
          () =>
            compiler().compile({
              sandboxName: "demo",
              agent: "hermes",
              workflow: "rebuild",
              isInteractive: false,
              configuredChannels: ["teams"],
              credentialAvailability: {
                MSTEAMS_APP_PASSWORD: true,
              },
            }),
        ),
      ).rejects.toThrow(/line breaks/);
    }
  });

  it("applies Microsoft Teams manifest defaults when optional env keys are unset", async () => {
    const plan = await withEnv(
      {
        MSTEAMS_APP_ID: "test-teams-app-id",
        MSTEAMS_TENANT_ID: "test-teams-tenant-id",
        TEAMS_ALLOWED_USERS: "00000000-0000-0000-0000-000000000001",
        MSTEAMS_PORT: undefined,
        TEAMS_PORT: undefined,
        TEAMS_REQUIRE_MENTION: undefined,
      },
      () =>
        compiler().compile({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "rebuild",
          isInteractive: false,
          configuredChannels: ["teams"],
          credentialAvailability: {
            MSTEAMS_APP_PASSWORD: true,
          },
        }),
    );

    const teams = plan.channels.find((channel) => channel.channelId === "teams");
    expect(teams?.inputs).toContainEqual(
      expect.objectContaining({
        inputId: "webhookPort",
        kind: "config",
        value: "3978",
      }),
    );
    expect(teams?.hostForward).toEqual({
      channelId: "teams",
      port: 3978,
      label: "Microsoft Teams webhook",
    });
    expect(teams?.inputs).toContainEqual(
      expect.objectContaining({
        inputId: "requireMention",
        kind: "config",
        value: "1",
      }),
    );
    expect(JSON.stringify(plan.agentRender)).toContain('"port":3978');
    expect(JSON.stringify(plan.agentRender)).toContain('"groupPolicy":"open"');
    expect(JSON.stringify(plan.agentRender)).not.toContain("groupAllowFrom");
    expect(JSON.stringify(plan.agentRender)).toContain('"requireMention":true');
  });

  it("keeps Microsoft Teams active when no explicit user allowlist is provided", async () => {
    const plan = await withEnv(
      {
        MSTEAMS_APP_ID: "test-teams-app-id",
        MSTEAMS_TENANT_ID: "test-teams-tenant-id",
        TEAMS_ALLOWED_USERS: undefined,
      },
      () =>
        compiler().compile({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "rebuild",
          isInteractive: false,
          configuredChannels: ["teams"],
          credentialAvailability: {
            MSTEAMS_APP_PASSWORD: true,
          },
        }),
    );

    expect(plan.channels.find((channel) => channel.channelId === "teams")).toMatchObject({
      active: true,
      configured: true,
      disabled: false,
    });
    expect(JSON.stringify(plan.agentRender)).toContain("channels.msteams");
    expect(JSON.stringify(plan.agentRender)).toContain('"groupPolicy":"open"');
    expect(JSON.stringify(plan.agentRender)).not.toContain("dmPolicy");
    expect(JSON.stringify(plan.agentRender)).not.toContain("allowFrom");
  });

  it("uses the configured Microsoft Teams webhook port for host forwarding", async () => {
    const plan = await withEnv(
      {
        ...TEST_TEAMS_ENV,
        MSTEAMS_PORT: "3977",
      },
      () =>
        compiler().compile({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "rebuild",
          isInteractive: false,
          configuredChannels: ["teams"],
          credentialAvailability: {
            MSTEAMS_APP_PASSWORD: true,
          },
        }),
    );

    const teams = plan.channels.find((channel) => channel.channelId === "teams");
    expect(teams?.hostForward).toEqual({
      channelId: "teams",
      port: 3977,
      label: "Microsoft Teams webhook",
    });
    expect(JSON.stringify(plan.agentRender)).toContain('"port":3977');
  });

  it("rejects invalid Microsoft Teams webhook ports", async () => {
    await expect(
      withEnv(
        {
          ...TEST_TEAMS_ENV,
          MSTEAMS_PORT: "70000",
        },
        () =>
          compiler().compile({
            sandboxName: "demo",
            agent: "openclaw",
            workflow: "rebuild",
            isInteractive: false,
            configuredChannels: ["teams"],
            credentialAvailability: {
              MSTEAMS_APP_PASSWORD: true,
            },
          }),
      ),
    ).rejects.toThrow(/Microsoft Teams webhook port/);
  });
});
