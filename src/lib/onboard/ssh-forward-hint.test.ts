// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildSshForwardHintLines, isSshSession } from "./ssh-forward-hint";

describe("ssh-forward-hint", () => {
  describe("isSshSession", () => {
    it("detects SSH_CONNECTION, SSH_CLIENT, and SSH_TTY", () => {
      expect(isSshSession({ SSH_CONNECTION: "10.0.0.1 5000 10.0.0.2 22" })).toBe(true);
      expect(isSshSession({ SSH_CLIENT: "10.0.0.1 5000 22" })).toBe(true);
      expect(isSshSession({ SSH_TTY: "/dev/pts/0" })).toBe(true);
    });

    it("returns false outside an SSH session", () => {
      expect(isSshSession({})).toBe(false);
    });
  });

  describe("buildSshForwardHintLines", () => {
    it("builds a copy-pastable ssh -L example from SSH_CONNECTION (#5925)", () => {
      const lines = buildSshForwardHintLines({
        port: 18790,
        accessUrl: "http://127.0.0.1:18790",
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
      });

      expect(lines).toEqual([
        "  Remote access (SSH session detected):",
        "    On your workstation, run:",
        "      ssh -L 18790:127.0.0.1:18790 spark@10.6.76.40",
        "    Then open the dashboard URL above in your local browser.",
      ]);
    });

    it("falls back to placeholders when host and user are unavailable", () => {
      const lines = buildSshForwardHintLines({
        port: 18790,
        accessUrl: "http://127.0.0.1:18790",
        env: { SSH_TTY: "/dev/pts/0" },
      });

      expect(lines?.[2]).toBe("      ssh -L 18790:127.0.0.1:18790 <user>@<host>");
    });

    it("rejects unsafe usernames in favor of the placeholder", () => {
      const lines = buildSshForwardHintLines({
        port: 18790,
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "evil; rm -rf" },
      });

      expect(lines?.[2]).toBe("      ssh -L 18790:127.0.0.1:18790 <user>@10.6.76.40");
    });

    it("respects a custom indent and open hint", () => {
      const lines = buildSshForwardHintLines({
        port: 18790,
        indent: "",
        openHint: "Then open: http://127.0.0.1:18790/",
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
      });

      expect(lines).toEqual([
        "Remote access (SSH session detected):",
        "  On your workstation, run:",
        "    ssh -L 18790:127.0.0.1:18790 spark@10.6.76.40",
        "  Then open: http://127.0.0.1:18790/",
      ]);
    });

    it("returns null outside an SSH session", () => {
      expect(buildSshForwardHintLines({ port: 18790, env: {} })).toBeNull();
    });

    it("returns null when the dashboard already binds a routable address", () => {
      expect(
        buildSshForwardHintLines({
          port: 18790,
          accessUrl: "http://172.22.1.1:18790",
          env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
        }),
      ).toBeNull();
    });
  });
});
