// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  patchInstalledOpenClawMSTeamsMentions,
  patchMSTeamsMentionEntitiesInSource,
} from "../src/lib/messaging/channels/teams/hooks/msteams-mention-patch";

const AAD_ID = "205f29da-231e-4a0e-a0b2-b398e6302087";

function msteamsRuntimeFixture(): string {
  return [
    'const AI_GENERATED_ENTITY = { type: "https://schema.org/Message", "@type": "CreativeWork" };',
    "const TEAMS_BOT_ID_PATTERN = /^\\d+:[a-z0-9._=-]+(?::[a-z0-9._=-]+)*$/i;",
    "const AAD_OBJECT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;",
    "function isValidTeamsId(id) {",
    "\treturn TEAMS_BOT_ID_PATTERN.test(id) || AAD_OBJECT_ID_PATTERN.test(id);",
    "}",
    "function parseMentions(text) {",
    "\tconst mentionPattern = /@\\[([^\\]]+)\\]\\(([^)]+)\\)/g;",
    "\tconst entities = [];",
    "\treturn {",
    "\t\ttext: text.replace(mentionPattern, (match, name, id) => {",
    "\t\t\tconst trimmedId = id.trim();",
    "\t\t\tif (!isValidTeamsId(trimmedId)) return match;",
    "\t\t\tconst trimmedName = name.trim();",
    "\t\t\tconst mentionTag = `<at>${trimmedName}</at>`;",
    "\t\t\tentities.push({",
    '\t\t\t\ttype: "mention",',
    "\t\t\t\ttext: mentionTag,",
    "\t\t\t\tmentioned: {",
    "\t\t\t\t\tid: trimmedId,",
    "\t\t\t\t\tname: trimmedName",
    "\t\t\t\t}",
    "\t\t\t});",
    "\t\t\treturn mentionTag;",
    "\t\t}),",
    "\t\tentities",
    "\t};",
    "}",
    "export async function buildActivity(msg) {",
    '\tconst activity = { type: "message" };',
    "\tactivity.channelData = { feedbackLoopEnabled: false };",
    "\tif (msg.text) {",
    "\t\tconst { text: formattedText, entities } = parseMentions(msg.text);",
    "\t\tactivity.text = formattedText;",
    "\t\tactivity.entities = [...entities.length > 0 ? entities : [], AI_GENERATED_ENTITY];",
    "\t} else activity.entities = [AI_GENERATED_ENTITY];",
    "\treturn activity;",
    "}",
    "",
  ].join("\n");
}

describe("OpenClaw Microsoft Teams mention patch", () => {
  it("accepts spaced display-name AAD mentions as Teams mention entities", async () => {
    const patched = patchMSTeamsMentionEntitiesInSource(msteamsRuntimeFixture());
    expect(patched.status).toBe("would-apply");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-mention-patch-"));
    const runtimeFile = path.join(tmp, "runtime.mjs");
    try {
      fs.writeFileSync(runtimeFile, patched.nextSource);
      const runtime = (await import(`${pathToFileURL(runtimeFile).href}?t=${Date.now()}`)) as {
        buildActivity: (msg: { text: string }) => Promise<{
          text: string;
          entities: Array<Record<string, unknown>>;
        }>;
      };

      const activity = await runtime.buildActivity({
        text: `@[San Dang] (${AAD_ID}) I've tagged you!`,
      });

      expect(activity.text).toBe(`<at>San Dang</at> I've tagged you!`);
      expect(activity.entities[0]).toEqual({
        type: "mention",
        text: "<at>San Dang</at>",
        mentioned: {
          id: AAD_ID,
          name: "San Dang",
        },
      });
      expect(JSON.stringify(activity)).not.toContain(`San Dang] (${AAD_ID})`);
      expect(activity.entities.at(-1)).toEqual({
        type: "https://schema.org/Message",
        "@type": "CreativeWork",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not rewrite loose email-like text as a Teams mention", async () => {
    const patched = patchMSTeamsMentionEntitiesInSource(msteamsRuntimeFixture());
    expect(patched.status).toBe("would-apply");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-mention-boundary-"));
    const runtimeFile = path.join(tmp, "runtime.mjs");
    try {
      fs.writeFileSync(runtimeFile, patched.nextSource);
      const runtime = (await import(`${pathToFileURL(runtimeFile).href}?t=${Date.now()}`)) as {
        buildActivity: (msg: { text: string }) => Promise<{
          text: string;
          entities: Array<Record<string, unknown>>;
        }>;
      };

      const sourceText = `contact foo@San Dang (${AAD_ID}) please`;
      const activity = await runtime.buildActivity({ text: sourceText });

      expect(activity.text).toBe(sourceText);
      expect(activity.entities).toHaveLength(1);
      expect(activity.entities[0]).toEqual({
        type: "https://schema.org/Message",
        "@type": "CreativeWork",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("patches the installed msteams runtime once and preserves explicit mention syntax", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-plugin-root-"));
    const runtimeDir = path.join(tmp, "msteams", "dist");
    const runtimeFile = path.join(runtimeDir, "probe.js");
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(runtimeFile, msteamsRuntimeFixture());

      patchInstalledOpenClawMSTeamsMentions({ NEMOCLAW_MSTEAMS_PLUGIN_ROOT: tmp });
      const firstPatch = fs.readFileSync(runtimeFile, "utf-8");
      patchInstalledOpenClawMSTeamsMentions({ NEMOCLAW_MSTEAMS_PLUGIN_ROOT: tmp });
      expect(fs.readFileSync(runtimeFile, "utf-8")).toBe(firstPatch);

      const runtime = (await import(`${pathToFileURL(runtimeFile).href}?t=${Date.now()}`)) as {
        buildActivity: (msg: { text: string }) => Promise<{
          text: string;
          entities: Array<Record<string, unknown>>;
        }>;
      };
      const activity = await runtime.buildActivity({
        text: `Hello @[San Dang](${AAD_ID})`,
      });

      expect(activity.text).toBe("Hello <at>San Dang</at>");
      expect(activity.entities[0]).toMatchObject({
        type: "mention",
        text: "<at>San Dang</at>",
        mentioned: { id: AAD_ID, name: "San Dang" },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats an upstream spaced mention parser as already patched", () => {
    const upstreamFixedSource = msteamsRuntimeFixture().replace(
      "const mentionPattern = /@\\[([^\\]]+)\\]\\(([^)]+)\\)/g;",
      "const mentionPattern = /@\\[([^\\]]+)\\]\\s*\\(([^)]+)\\)/g;",
    );

    const patched = patchMSTeamsMentionEntitiesInSource(upstreamFixedSource);

    expect(patched.status).toBe("already-applied");
    expect(patched.nextSource).toBe(upstreamFixedSource);
  });
});
