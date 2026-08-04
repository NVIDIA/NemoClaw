// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { planRuntimeSetup } from "../../../compiler/engines/runtime-setup-engine";
import { whatsappManifest } from "../manifest";
import {
  applyHermesWhatsappSessionPatch,
  HERMES_WHATSAPP_SESSION_PATH,
  normalizeHermesWhatsappSessionArgv,
} from "./whatsapp-hermes-session";

describe("Hermes WhatsApp session runtime preload", () => {
  it.each([
    "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
    "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
  ])("normalizes %s to the durable session path (#8184)", (bridgePath) => {
    const argv = ["/usr/local/bin/node", bridgePath, "--session", "/split/session"];

    expect(normalizeHermesWhatsappSessionArgv(argv)).toBe(true);
    expect(argv[3]).toBe(HERMES_WHATSAPP_SESSION_PATH);
  });

  it("leaves unrelated Node processes unchanged (#8184)", () => {
    const argv = ["/usr/local/bin/node", "/sandbox/tool.js", "--session", "/keep"];

    expect(normalizeHermesWhatsappSessionArgv(argv)).toBe(false);
    expect(argv[3]).toBe("/keep");
  });

  it("keeps paired credentials shared with the Hermes gateway group (#8184)", () => {
    const modes: number[] = [];
    const argv = [
      "/usr/local/bin/node",
      "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
      "--session",
      "/split/session",
    ];

    expect(applyHermesWhatsappSessionPatch(argv, (mode) => modes.push(mode))).toBe(true);
    expect(modes).toEqual([0o007]);
  });

  it.each([
    ["missing", ["/usr/local/bin/node", "/sandbox/whatsapp-bridge/bridge.js"]],
    [
      "duplicate",
      [
        "/usr/local/bin/node",
        "/sandbox/whatsapp-bridge/bridge.js",
        "--session",
        "/one",
        "--session",
        "/two",
      ],
    ],
  ])("refuses a %s Hermes bridge session argument (#8184)", (_case, argv) => {
    expect(() => normalizeHermesWhatsappSessionArgv(argv)).toThrow(
      "did not provide exactly one session path",
    );
  });

  it("declares the mandatory preload for Hermes boot and connect (#8184)", () => {
    const runtime = planRuntimeSetup([whatsappManifest], "hermes", [
      {
        channelId: "whatsapp",
        displayName: "WhatsApp",
        authMode: "in-sandbox-qr",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ]);

    expect(runtime.nodePreloads).toEqual([
      expect.objectContaining({
        channelId: "whatsapp",
        source: "/usr/local/lib/nemoclaw/preloads/whatsapp-hermes-session.js",
        target: "/tmp/nemoclaw-whatsapp-hermes-session.js",
        injectInto: ["boot", "connect"],
        optional: false,
      }),
    ]);
  });
});
