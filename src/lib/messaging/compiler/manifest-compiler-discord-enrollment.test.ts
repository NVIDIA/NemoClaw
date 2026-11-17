// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../channels";
import { createBuiltInMessagingHookRegistry } from "../hooks";
import { ManifestCompiler } from "./manifest-compiler";

describe("ManifestCompiler Discord enrollment", () => {
  it.each([
    ["hermes", "onboard"],
    ["hermes", "add-channel"],
    ["openclaw", "onboard"],
    ["openclaw", "add-channel"],
  ] as const)(
    "does not save a rejected prompted Discord token and prompts again for %s %s (#13809)",
    async (agent, workflow) => {
      const env: NodeJS.ProcessEnv = {};
      const credentials = new Map<string, string>();
      const saveCredential = vi.fn((key: string, value: string) => credentials.set(key, value));
      const prompt = vi
        .fn(async (_question: string, _options?: { secret?: boolean }) => "")
        .mockResolvedValueOnce("rejected-discord-test-token")
        .mockResolvedValueOnce("replacement-discord-test-token");
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
        .mockResolvedValueOnce(Response.json({ id: "123", bot: true }));
      const log = vi.fn();
      const subject = new ManifestCompiler(
        createBuiltInChannelManifestRegistry(),
        createBuiltInMessagingHookRegistry({
          common: {
            env,
            getCredential: (key) => credentials.get(key) ?? null,
            saveCredential,
            prompt,
            log,
          },
          discord: { authentication: { fetch: request, log } },
        }),
        createBuiltInRenderTemplateResolver(),
      );
      const input = {
        sandboxName: "demo",
        agent,
        workflow,
        isInteractive: true,
        configuredChannels: ["discord"],
      };
      const rejected = await subject.compile(input);
      expect(rejected.channels[0]).toMatchObject({ active: false, disabled: true });
      expect(credentials.has("DISCORD_BOT_TOKEN")).toBe(false);
      expect(saveCredential).not.toHaveBeenCalled();
      expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
      expect(prompt).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain("rejected-discord-test-token");
      expect(JSON.stringify(log.mock.calls)).not.toContain("token saved");

      const accepted = await subject.compile(input);
      expect(accepted.channels[0]).toMatchObject({ active: true, disabled: false });
      expect(saveCredential).toHaveBeenCalledExactlyOnceWith(
        "DISCORD_BOT_TOKEN",
        "replacement-discord-test-token",
      );
      expect(env.DISCORD_BOT_TOKEN).toBe("replacement-discord-test-token");
      expect(request).toHaveBeenCalledTimes(2);
      expect(JSON.stringify([rejected, accepted])).not.toContain("discord-test-token");
    },
  );

  it("preserves an externally supplied Discord token after authentication rejects it (#13809)", async () => {
    const env = { DISCORD_BOT_TOKEN: "  rejected-external-test-token  " };
    const saveCredential = vi.fn();
    const prompt = vi.fn(async () => "");
    const subject = new ManifestCompiler(
      createBuiltInChannelManifestRegistry(),
      createBuiltInMessagingHookRegistry({
        common: { env, getCredential: () => null, saveCredential, prompt, log: () => {} },
        discord: {
          authentication: {
            fetch: async () => new Response("Unauthorized", { status: 401 }),
            log: () => {},
          },
        },
      }),
      createBuiltInRenderTemplateResolver(),
    );
    const rejected = await subject.compile({
      sandboxName: "demo",
      agent: "hermes",
      workflow: "add-channel",
      isInteractive: false,
      configuredChannels: ["discord"],
    });
    expect(rejected.channels[0]).toMatchObject({ active: false, disabled: true });
    expect(env.DISCORD_BOT_TOKEN).toBe("  rejected-external-test-token  ");
    expect(saveCredential).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});
