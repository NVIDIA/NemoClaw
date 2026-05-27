// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";

// Import from compiled dist/ for correct coverage attribution.
async function loadVerifier(): Promise<typeof import("../../../dist/lib/shields/verify-lock")> {
  const distModulePath = path.join(
    process.cwd(),
    "dist",
    "lib",
    "shields",
    "verify-lock.js",
  );
  return import(distModulePath);
}

const target = {
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

type StatLookup = Record<string, string>;

function makeExec(perms: StatLookup): (cmd: string[]) => string {
  return (cmd: string[]) => {
    if (cmd[0] === "stat") {
      const file = cmd[cmd.length - 1];
      if (file in perms) return perms[file];
    }
    return "";
  };
}

describe("verifyShieldsLockState", () => {
  it("returns ok when all locked files and the config dir match the expected perms", async () => {
    const { verifyShieldsLockState } = await loadVerifier();
    const exec = makeExec({
      "/sandbox/.openclaw/openclaw.json": "444 root:root",
      "/sandbox/.openclaw/.config-hash": "444 root:root",
      "/sandbox/.openclaw": "755 root:root",
    });

    const result = verifyShieldsLockState("openclaw", target, { exec });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags drift when host-root tamper reverts dir + files to sandbox-writable perms", async () => {
    const { verifyShieldsLockState } = await loadVerifier();
    const exec = makeExec({
      "/sandbox/.openclaw/openclaw.json": "660 sandbox:sandbox",
      "/sandbox/.openclaw/.config-hash": "660 sandbox:sandbox",
      "/sandbox/.openclaw": "2770 sandbox:sandbox",
    });

    const result = verifyShieldsLockState("openclaw", target, { exec });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "/sandbox/.openclaw/openclaw.json mode=660 (expected 444)",
        "/sandbox/.openclaw/openclaw.json owner=sandbox:sandbox (expected root:root)",
        "/sandbox/.openclaw/.config-hash mode=660 (expected 444)",
        "/sandbox/.openclaw/.config-hash owner=sandbox:sandbox (expected root:root)",
        "dir mode=2770 (expected 755)",
        "dir owner=sandbox:sandbox (expected root:root)",
      ]),
    );
  });

  it.each([
    ["402", "world-writable file"],
    ["420", "group-writable file"],
    ["422", "group + world-writable file"],
    ["440", "missing world read"],
    ["404", "missing group read"],
    ["644", "owner-writable file"],
    ["445", "world-execute file"],
  ])(
    "rejects mode %s (%s) so writable perms cannot masquerade as locked",
    async (mode, _description) => {
      const { verifyShieldsLockState } = await loadVerifier();
      const exec = makeExec({
        "/sandbox/.openclaw/openclaw.json": `${mode} root:root`,
        "/sandbox/.openclaw/.config-hash": "444 root:root",
        "/sandbox/.openclaw": "755 root:root",
      });

      const result = verifyShieldsLockState("openclaw", target, { exec });

      expect(result.ok).toBe(false);
      expect(result.issues).toContain(
        `/sandbox/.openclaw/openclaw.json mode=${mode} (expected 444)`,
      );
    },
  );

  it("rejects any non-755 dir mode even when the file modes are clean", async () => {
    const { verifyShieldsLockState } = await loadVerifier();
    const exec = makeExec({
      "/sandbox/.openclaw/openclaw.json": "444 root:root",
      "/sandbox/.openclaw/.config-hash": "444 root:root",
      "/sandbox/.openclaw": "775 root:root",
    });

    const result = verifyShieldsLockState("openclaw", target, { exec });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("dir mode=775 (expected 755)");
  });

  it("reports stat failures as drift when the sandbox cannot be reached", async () => {
    const { verifyShieldsLockState } = await loadVerifier();
    const exec = (_cmd: string[]): string => {
      throw new Error("Container not found");
    };

    const result = verifyShieldsLockState("openclaw", target, { exec });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue: string) => issue.includes("stat failed"))).toBe(
      true,
    );
    expect(
      result.issues.some((issue: string) => issue.includes("Container not found")),
    ).toBe(true);
  });

  it("flags missing immutable bit only when verifyChattr is requested", async () => {
    const { verifyShieldsLockState } = await loadVerifier();
    const exec = (cmd: string[]): string => {
      if (cmd[0] === "stat") {
        if (cmd[cmd.length - 1] === "/sandbox/.openclaw") return "755 root:root";
        return "444 root:root";
      }
      if (cmd[0] === "lsattr") {
        // No 'i' flag present.
        return `----e----- ${cmd[cmd.length - 1]}`;
      }
      return "";
    };

    const withoutChattrCheck = verifyShieldsLockState("openclaw", target, { exec });
    expect(withoutChattrCheck.ok).toBe(true);

    const withChattrCheck = verifyShieldsLockState("openclaw", target, {
      exec,
      verifyChattr: true,
    });
    expect(withChattrCheck.ok).toBe(false);
    expect(withChattrCheck.issues).toEqual(
      expect.arrayContaining([
        "/sandbox/.openclaw/openclaw.json immutable bit not set",
        "/sandbox/.openclaw/.config-hash immutable bit not set",
      ]),
    );
  });

  it("surfaces a legacy state layout violation when the asserter throws", async () => {
    const { verifyShieldsLockState } = await loadVerifier();
    const exec = makeExec({
      "/sandbox/.openclaw/openclaw.json": "444 root:root",
      "/sandbox/.openclaw/.config-hash": "444 root:root",
      "/sandbox/.openclaw": "755 root:root",
    });

    const result = verifyShieldsLockState("openclaw", target, {
      exec,
      assertLegacyLayout: () => {
        throw new Error("legacy data dir exists: /sandbox/.openclaw-data");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain(
      "legacy data dir exists: /sandbox/.openclaw-data",
    );
  });

  it("rejects calls without an exec dependency so production paths cannot silently no-op", async () => {
    const { verifyShieldsLockState } = await loadVerifier();
    const call = verifyShieldsLockState as unknown as (
      name: string,
      lockTarget: unknown,
    ) => unknown;
    expect(() => call("openclaw", target)).toThrow(/requires options\.exec/);
  });
});
