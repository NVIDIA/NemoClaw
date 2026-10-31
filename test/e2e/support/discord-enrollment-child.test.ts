// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveLiveE2eWorkloadSourceEnv } from "../fixtures/shell-probe.ts";
import { installSandbox, phase6Env } from "../live/phase6-messaging-helpers.ts";
import { messagingEnv } from "../live/messaging-providers-helpers.ts";
import { runHermesNvidiaDiscordRebuild } from "../live/hermes-inference-switch-helpers.ts";

const COMPILER_PROBE = String.raw`
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/fixture-child.cjs");
const { ManifestCompiler } = require("./src/lib/messaging/compiler/manifest-compiler.ts");
const { createBuiltInChannelManifestRegistry, createBuiltInRenderTemplateResolver } = require("./src/lib/messaging/channels/index.ts");
const { createBuiltInMessagingHookRegistry } = require("./src/lib/messaging/hooks/index.ts");
const compiler = new ManifestCompiler(
  createBuiltInChannelManifestRegistry(),
  createBuiltInMessagingHookRegistry({ common: { log() {} }, discord: { authentication: { log() {} } } }),
  createBuiltInRenderTemplateResolver(),
);
const plan = await compiler.compile({
  sandboxName: process.env.NEMOCLAW_SANDBOX_NAME,
  agent: process.env.NEMOCLAW_AGENT,
  workflow: "onboard", isInteractive: false, configuredChannels: ["discord"],
});
console.log(JSON.stringify({ active: plan.channels[0].active, disabled: plan.channels[0].disabled,
  fallbackUrls: globalThis.fixtureRequests }));
`;

let directory: string;
let transportOptions: string;

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "discord-enrollment-child-"));
  const transport = path.join(directory, "deny-network.cjs");
  fs.writeFileSync(
    transport,
    `globalThis.fixtureRequests = [];
globalThis.fetch = async (input) => {
  globalThis.fixtureRequests.push(input instanceof Request ? input.url : String(input));
  return new Response("Unauthorized", { status: 401 });
};
`,
  );
  transportOptions = `--require=${transport}`;
});

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function runChild(env: NodeJS.ProcessEnv, source = COMPILER_PROBE) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: REPO_ROOT,
      env: resolveLiveE2eWorkloadSourceEnv({ ...env, TMPDIR: directory }),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

describe("Discord enrollment in live-test children", () => {
  it("enrolls the messaging-provider fixture in its actual child environment (#13809)", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN_REAL", "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    try {
      const { env } = messagingEnv();
      expect(
        runChild({
          ...env,
          NEMOCLAW_AGENT: "openclaw",
          NODE_OPTIONS: `${transportOptions} ${env.NODE_OPTIONS ?? ""}`.trim(),
        }),
      ).toEqual({ active: true, disabled: false, fallbackUrls: [] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("authenticates native Hermes enrollment and its stored-credential rebuild (#13809)", async () => {
    const success = {
      command: [],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      artifacts: { stdout: "", stderr: "", result: "" },
    };
    const proveEnrollment = (options: NodeJS.ProcessEnv | undefined, source: string) => {
      expect(
        runChild(
          {
            ...options,
            NEMOCLAW_SANDBOX_NAME: "e2e-hm-inf-switch",
            NEMOCLAW_AGENT: "hermes",
            NODE_OPTIONS: `${transportOptions} ${options?.NODE_OPTIONS ?? ""}`.trim(),
          },
          source,
        ),
      ).toEqual({ active: true, disabled: false, fallbackUrls: [] });
      return success;
    };
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockImplementationOnce(async (_binary, _args, options) =>
        proveEnrollment(options?.env, COMPILER_PROBE),
      )
      .mockImplementationOnce(async (_binary, _args, options) =>
        proveEnrollment(
          options?.env,
          COMPILER_PROBE.replace(
            "common: { log() {} }",
            'common: { log() {}, getCredential: (key) => key === "DISCORD_BOT_TOKEN" ? "test-fake-discord-token-hermes-e2e" : null }',
          ),
        ),
      )
      .mockResolvedValue({
        ...success,
        stdout: JSON.stringify({
          provider: "nvidia-prod",
          inferenceHealth: { ok: true, probed: true },
        }),
      });
    await runHermesNvidiaDiscordRebuild({
      host: { command },
      sandbox: {
        exec: vi.fn(async (_name, args) => ({
          command: [],
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: args.includes("-z")
            ? "PROBE_OK"
            : JSON.stringify({
                enabled: true,
                requireMention: true,
                guildIds: "1491590992753590594",
                allowedUsers: "1005536447329222676",
              }),
          stderr: "",
          artifacts: { stdout: "", stderr: "", result: "" },
        })),
      },
      progress: { phase() {} },
      publicApiKey: "synthetic-public-key",
      redactionValues: [],
    });
    expect(command.mock.calls[1]![2]!.env).not.toHaveProperty("DISCORD_BOT_TOKEN");
    expect(command.mock.calls[1]![2]!.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ["Slack", { SLACK_BOT_TOKEN: "xoxb-synthetic", SLACK_APP_TOKEN: "xapp-synthetic" }],
    ["Telegram", { TELEGRAM_BOT_TOKEN: "synthetic-telegram-token" }],
    ["no channel", {}],
  ])(
    "preserves the %s child environment without a Discord token (#13809)",
    (_channel, credentials) => {
      const env = phase6Env({
        sandboxName: "e2e-oc-ch-cycle",
        agent: "openclaw",
        extra: { ...credentials, DISCORD_BOT_TOKEN: undefined, NODE_OPTIONS: transportOptions },
      });

      expect(env.NODE_OPTIONS).toBe(transportOptions);
      expect(env).toMatchObject(credentials);
      expect(
        runChild(
          env,
          String.raw`
await fetch("https://discord.com/api/v10/users/@me");
console.log(JSON.stringify({ slack: process.env.SLACK_BOT_TOKEN,
  slackApp: process.env.SLACK_APP_TOKEN, telegram: process.env.TELEGRAM_BOT_TOKEN,
  fallbackUrls: globalThis.fixtureRequests }));
`,
        ),
      ).toMatchObject({
        ...(credentials.SLACK_BOT_TOKEN ? { slack: credentials.SLACK_BOT_TOKEN } : {}),
        ...(credentials.SLACK_APP_TOKEN ? { slackApp: credentials.SLACK_APP_TOKEN } : {}),
        ...(credentials.TELEGRAM_BOT_TOKEN ? { telegram: credentials.TELEGRAM_BOT_TOKEN } : {}),
        fallbackUrls: ["https://discord.com/api/v10/users/@me"],
      });
    },
  );

  it("carries the catalogue fixture through the installer helper into the child (#13809)", async () => {
    const target = catalogueTarget("channels-stop-start-openclaw");
    const env = phase6Env({
      sandboxName: target.environment.NEMOCLAW_SANDBOX_NAME,
      agent: "openclaw",
      extra: { ...target.environment, NODE_OPTIONS: transportOptions },
    });
    const command = vi.fn<HostCliClient["command"]>(async (binary, args = [], options = {}) => ({
      command: [binary, ...args],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify(runChild(options.env!)),
      stderr: "",
      artifacts: { stdout: "", stderr: "", result: "" },
    }));

    const result = await installSandbox(
      { command } as unknown as HostCliClient,
      env,
      [],
      "install-channels-stop-start-openclaw",
    );

    expect(command).toHaveBeenCalledExactlyOnceWith(
      "bash",
      ["install.sh", "--non-interactive"],
      expect.objectContaining({ cwd: REPO_ROOT, env }),
    );
    expect(JSON.parse(result.stdout)).toEqual({ active: true, disabled: false, fallbackUrls: [] });
  });

  it.each([
    ["openclaw", "test-fake-discord-token-stop-start-openclaw"],
    ["hermes", "test-fake-discord-token-stop-start-hermes"],
    ["openclaw", "test-fake-discord-token-openclaw"],
    ["hermes", "test-fake-discord-token-hermes"],
    ["openclaw", "test-fake-discord-pairing-e2e"],
    ["hermes", "test-fake-discord-token-hermes-e2e"],
    ["openclaw", "dc-a-rotation-e2e"],
    ["openclaw", "dc-b-rotation-e2e"],
  ] as const)("enrolls the synthetic %s token %s inside the child (#13809)", (agent, token) => {
    const env = phase6Env({
      sandboxName: "e2e-oc-ch-cycle",
      agent,
      extra: { DISCORD_BOT_TOKEN: token, NODE_OPTIONS: transportOptions },
    });
    expect(runChild(env)).toEqual({ active: true, disabled: false, fallbackUrls: [] });
  });

  it("keeps synthetic tokens rejected without the test-only composition (#13809)", () => {
    expect(
      runChild({
        PATH: process.env.PATH,
        NEMOCLAW_SANDBOX_NAME: "e2e-oc-ch-cycle",
        NEMOCLAW_AGENT: "openclaw",
        DISCORD_BOT_TOKEN: "test-fake-discord-token-stop-start-openclaw",
        NODE_OPTIONS: transportOptions,
      }),
    ).toEqual({
      active: false,
      disabled: true,
      fallbackUrls: ["https://discord.com/api/v10/users/@me"],
    });
  });

  it("passes non-fixture tokens through authentication and keeps rejection (#13809)", () => {
    expect(
      runChild(
        phase6Env({
          sandboxName: "e2e-oc-ch-cycle",
          agent: "openclaw",
          extra: { DISCORD_BOT_TOKEN: "invalid-token-for-test", NODE_OPTIONS: transportOptions },
        }),
      ),
    ).toEqual({
      active: false,
      disabled: true,
      fallbackUrls: ["https://discord.com/api/v10/users/@me"],
    });
  });

  it("limits the child transport to the matching identity GET request (#13809)", () => {
    const env = phase6Env({
      sandboxName: "e2e-oc-ch-cycle",
      agent: "openclaw",
      extra: {
        DISCORD_BOT_TOKEN: "test-fake-discord-token-stop-start-openclaw",
        NODE_OPTIONS: transportOptions,
      },
    });
    expect(env.NODE_OPTIONS).toContain(transportOptions);
    expect(
      runChild(
        env,
        String.raw`
const url = "https://discord.com/api/v10/users/@me";
const headers = { Authorization: "Bot " + process.env.DISCORD_BOT_TOKEN };
const accepted = await fetch(new Request(url, { headers }));
const wrongToken = await fetch(url, { headers: { Authorization: "Bot different-token" } });
const otherUrl = await fetch("https://example.test/other", { headers });
const post = await fetch(url, { method: "POST", headers });
console.log(JSON.stringify({ statuses: [accepted.status, wrongToken.status, otherUrl.status, post.status],
  fallbackUrls: globalThis.fixtureRequests }));
`,
      ),
    ).toEqual({
      statuses: [200, 401, 401, 401],
      fallbackUrls: [
        "https://discord.com/api/v10/users/@me",
        "https://example.test/other",
        "https://discord.com/api/v10/users/@me",
      ],
    });
  });
});
