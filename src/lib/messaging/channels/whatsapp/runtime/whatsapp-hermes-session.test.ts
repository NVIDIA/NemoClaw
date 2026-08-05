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
  it("moves dashboard pairing to the gateway session path (#8184)", () => {
    const argv = [
      "/usr/local/bin/node",
      "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
      "--session",
      "/sandbox/.hermes/dashboard-home/platforms/whatsapp/session",
    ];

    expect(normalizeHermesWhatsappSessionArgv(argv)).toBe(true);
    expect(argv[3]).toBe(HERMES_WHATSAPP_SESSION_PATH);
  });

  it.each([
    ["CLI and gateway", "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js"],
    ["installed gateway", "/opt/hermes/scripts/whatsapp-bridge/bridge.js"],
    ["unrelated Node process", "/sandbox/tool.js"],
  ])("leaves the %s bridge session path unchanged (#8184)", (_case, bridgePath) => {
    const argv = ["/usr/local/bin/node", bridgePath, "--session", "/keep"];

    expect(normalizeHermesWhatsappSessionArgv(argv)).toBe(false);
    expect(argv[3]).toBe("/keep");
  });

  it("leaves a path-shaped unrelated bridge and its umask unchanged (#8184)", () => {
    const modes: number[] = [];
    const argv = [
      "/usr/local/bin/node",
      "/sandbox/unrelated/whatsapp-bridge/bridge.js",
      "--session",
      "/keep",
    ];

    expect(applyHermesWhatsappSessionPatch(argv, (mode) => modes.push(mode))).toBe(false);
    expect(argv[3]).toBe("/keep");
    expect(modes).toEqual([]);
  });

  it("keeps paired credentials shared with the Hermes gateway group (#8184)", () => {
    const modes: number[] = [];
    const argv = [
      "/usr/local/bin/node",
      "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
      "--session",
      "/split/session",
    ];

    expect(applyHermesWhatsappSessionPatch(argv, (mode) => modes.push(mode))).toBe(true);
    expect(modes).toEqual([0o007]);
  });

  it.each([
    [
      "missing",
      ["/usr/local/bin/node", "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js"],
    ],
    [
      "missing before another option",
      [
        "/usr/local/bin/node",
        "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
        "--session",
        "--mode",
        "bot",
      ],
    ],
    [
      "duplicate",
      [
        "/usr/local/bin/node",
        "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
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

  it("declares the mandatory preload only for Hermes boot (#8184)", () => {
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
        injectInto: ["boot"],
        optional: false,
      }),
    ]);
  });
});
