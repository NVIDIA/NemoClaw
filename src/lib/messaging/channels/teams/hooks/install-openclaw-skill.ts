// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";

export const TEAMS_INSTALL_OPENCLAW_SKILL_HOOK_HANDLER_ID = "teams.installOpenClawSkill";
export const TEAMS_OPENCLAW_SKILL_PATH = "skills/msteams/SKILL.md";

export const MSTEAMS_OPENCLAW_SKILL_MD = `---
name: msteams
description: "Microsoft Teams/msteams message-tool ops: send/reply/read and tag users. Use for Teams channel context; mention users as @[Display Name](AAD_OBJECT_ID), never plain @Name."
metadata: { "openclaw": { "requires": { "config": ["channels.msteams"] } } }
allowed-tools: ["message"]
---

# Microsoft Teams Messaging

Use this skill automatically for any conversation whose Provider, Surface, OriginatingChannel, or SessionKey contains "msteams" or "Microsoft Teams".

Use the message tool with channel "msteams".

When mentioning a Teams user, write the mention as:

\`\`\`text
@[Display Name](AAD_OBJECT_ID)
\`\`\`

Do not write plain @Name, raw <at>Name</at>, or a standalone @ line. The Teams extension converts the bracket syntax into the Teams mention entity.

If the requester asks you to tag or mention themselves and the context includes SenderName and SenderId, use:

\`\`\`text
@[SenderName](SenderId)
\`\`\`
`;

export function createTeamsInstallOpenClawSkillHook(): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "teams") return {};
    return {
      outputs: {
        msteamsSkill: {
          kind: "build-file",
          value: {
            path: TEAMS_OPENCLAW_SKILL_PATH,
            mode: "0644",
            content: MSTEAMS_OPENCLAW_SKILL_MD,
          },
        },
      },
    };
  };
}

export function createTeamsInstallOpenClawSkillHookRegistration(): MessagingHookRegistration {
  return {
    id: TEAMS_INSTALL_OPENCLAW_SKILL_HOOK_HANDLER_ID,
    handler: createTeamsInstallOpenClawSkillHook(),
  };
}
