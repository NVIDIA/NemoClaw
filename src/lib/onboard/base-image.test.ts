// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  capture: vi.fn(),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerCapture: dockerMocks.capture,
}));

import { openClawBaseImageHasSecurityInventory } from "./base-image";

describe("OpenClaw sandbox base image validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts the exact immutable security package inventory", () => {
    dockerMocks.capture.mockReturnValue("nemoclaw-security-inventory-ok\n");

    expect(openClawBaseImageHasSecurityInventory("nemoclaw:test")).toBe(true);
    const [args, options] = dockerMocks.capture.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        "run",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--entrypoint",
        "/bin/sh",
        "nemoclaw:test",
        "-c",
      ]),
    );
    const probe = args.at(-1);
    expect(probe).toContain("security_inventory=/usr/local/share/nemoclaw/security-packages.txt");
    expect(probe).toContain('test ! -L "$security_inventory"');
    expect(probe).toContain(`stat -c '%u:%g:%a'`);
    expect(probe).toContain('"0:0:444"');
    expect(probe).toContain(`cmp -s - "$security_inventory"`);
    expect(probe).toContain('"perl-base=5.44.0-1nemoclaw1"');
    expect(probe).toContain('"perl=5.44.0-1nemoclaw1"');
    expect(probe).toContain('"libevent-core-2.1-7t64=2.1.13-stable-1"');
    expect(options).toEqual({ ignoreError: true, timeout: 20_000 });
  });

  it("rejects a base that predates the security inventory", () => {
    dockerMocks.capture.mockReturnValue("");

    expect(openClawBaseImageHasSecurityInventory("nemoclaw:v0.0.95")).toBe(false);
  });
});
