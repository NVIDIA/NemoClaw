// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { planRuntimeSetup } from "../../../compiler/engines/runtime-setup-engine";
import { whatsappManifest } from "../manifest";
import {
  applyHermesWhatsappSessionPatch,
  HERMES_WHATSAPP_SESSION_PATH,
  normalizeHermesWhatsappSessionArgv,
  runHermesWhatsappPairing,
} from "./whatsapp-hermes-session";

describe("Hermes WhatsApp session runtime preload", () => {
  it.each([
    "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
    "/sandbox/.hermes/dashboard-home/scripts/whatsapp-bridge/bridge.js",
  ])("forces %s to the manifest-owned durable session path (#8184)", (bridgePath) => {
    const argv = ["/usr/local/bin/node", bridgePath, "--session", "/split/session"];

    expect(normalizeHermesWhatsappSessionArgv(argv)).toBe(true);
    expect(argv[3]).toBe(HERMES_WHATSAPP_SESSION_PATH);
  });

  it("leaves unrelated Node processes unchanged (#8184)", () => {
    const argv = ["/usr/local/bin/node", "/sandbox/tool.js", "--session", "/keep"];

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
      "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
      "--session",
      "/split/session",
    ];

    expect(applyHermesWhatsappSessionPatch(argv, (mode) => modes.push(mode))).toBe(true);
    expect(modes).toEqual([0o007]);
  });

  it.each([
    ["missing", ["/usr/local/bin/node", "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js"]],
    [
      "missing before another option",
      [
        "/usr/local/bin/node",
        "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
        "--session",
        "--mode",
        "bot",
      ],
    ],
    [
      "duplicate",
      [
        "/usr/local/bin/node",
        "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
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
    expect(runtime.commandRoutes).toEqual([
      {
        channelId: "whatsapp",
        command: "hermes",
        args: ["whatsapp"],
        module: "whatsapp-hermes-session",
        source: "/usr/local/lib/nemoclaw/preloads/whatsapp-hermes-session.js",
      },
    ]);
  });

  it("pairs with managed settings without invoking the Hermes config writer (#8184)", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-whatsapp-pair-"));
    try {
      const envPath = path.join(fixture, ".env");
      const bridgePath = path.join(fixture, "bridge.js");
      const sessionPath = path.join(fixture, "platforms", "whatsapp", "session");
      fs.writeFileSync(
        envPath,
        [
          "WHATSAPP_ENABLED=true",
          "WHATSAPP_MODE=bot",
          "WHATSAPP_ALLOWED_USERS=15550000001",
          "UNRELATED_SECRET=do-not-forward",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(bridgePath, "// bridge fixture\n");
      const envModifiedAt = fs.statSync(envPath).mtimeMs;
      const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }));
      const modes: number[] = [];
      const output: string[] = [];

      expect(
        runHermesWhatsappPairing({
          envPath,
          sessionPath,
          bridgePaths: [bridgePath],
          nodePath: "/trusted/node",
          spawn: spawn as unknown as typeof spawnSync,
          setUmask: (mode) => modes.push(mode),
          write: (message) => output.push(message),
        }),
      ).toBe(0);

      expect(fs.statSync(envPath).isFile()).toBe(true);
      expect(fs.statSync(envPath).mtimeMs).toBe(envModifiedAt);
      expect(fs.readFileSync(envPath, "utf8")).toContain("UNRELATED_SECRET=do-not-forward");
      expect(fs.statSync(sessionPath).isDirectory()).toBe(true);
      expect(modes).toEqual([0o007]);
      expect(spawn).toHaveBeenCalledWith(
        "/trusted/node",
        [bridgePath, "--pair-only", "--session", sessionPath],
        expect.objectContaining({
          cwd: fixture,
          env: expect.objectContaining({
            WHATSAPP_MODE: "bot",
            WHATSAPP_ALLOWED_USERS: "15550000001",
          }),
          stdio: "inherit",
        }),
      );
      const childEnvironment = (spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)
        ?.env;
      expect(childEnvironment).not.toHaveProperty("UNRELATED_SECRET");
      expect(output.join("")).toContain(`Session: ${sessionPath}`);
      expect(output.join("")).not.toContain("15550000001");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
