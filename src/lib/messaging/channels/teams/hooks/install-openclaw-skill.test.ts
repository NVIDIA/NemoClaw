// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import type { ChannelHookSpec } from "../../../manifest";
import {
  createTeamsInstallOpenClawSkillHookRegistration,
  TEAMS_INSTALL_OPENCLAW_SKILL_HOOK_HANDLER_ID,
  TEAMS_OPENCLAW_SKILL_PATH,
} from "./install-openclaw-skill";

const HOOK = {
  id: "teams-install-openclaw-skill",
  phase: "post-agent-install",
  handler: TEAMS_INSTALL_OPENCLAW_SKILL_HOOK_HANDLER_ID,
  agents: ["openclaw"],
  outputs: [
    {
      id: "msteamsSkill",
      kind: "build-file",
      required: true,
    },
  ],
  onFailure: "abort",
} as const satisfies ChannelHookSpec;

describe("teams.installOpenClawSkill hook", () => {
  it("emits the msteams OpenClaw skill as a post-install build file", async () => {
    const registry = new MessagingHookRegistry([createTeamsInstallOpenClawSkillHookRegistration()]);

    await expect(runMessagingHook(HOOK, registry, { channelId: "teams" })).resolves.toEqual({
      hookId: "teams-install-openclaw-skill",
      handlerId: TEAMS_INSTALL_OPENCLAW_SKILL_HOOK_HANDLER_ID,
      phase: "post-agent-install",
      outputs: {
        msteamsSkill: {
          kind: "build-file",
          value: {
            path: TEAMS_OPENCLAW_SKILL_PATH,
            mode: "0644",
            content: expect.stringContaining(
              "Use for Teams channel context; mention users as @[Display Name](AAD_OBJECT_ID)",
            ),
          },
        },
      },
    });
  });
});
