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
    it("builds a copy-pastable ssh -L example with the real user and a <host> placeholder (#5925)", () => {
      const lines = buildSshForwardHintLines({
        port: 18790,
        accessUrl: "http://127.0.0.1:18790",
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
      });

      expect(lines).toEqual([
        "  Remote access (SSH session detected):",
        "    On your workstation, run:",
        "      ssh -L 18790:127.0.0.1:18790 spark@<host>",
        "    Then open the dashboard URL above in your local browser.",
      ]);
    });

    it("never leaks the SSH_CONNECTION socket IP across an alias, NAT, or ProxyJump (#5925)", () => {
      // An `~/.ssh/config` alias or ProxyJump makes the SSH_CONNECTION server-IP
      // (field 3) unrelated to what the operator typed, so it must never appear.
      for (const sshConnection of [
        "10.0.0.9 51000 10.6.76.40 22", // NAT'd / aliased direct host
        "203.0.113.8 40222 10.10.0.5 2222", // private bastion-side (ProxyJump) target on a custom port
      ]) {
        const lines = buildSshForwardHintLines({
          port: 18790,
          accessUrl: "http://127.0.0.1:18790",
          env: { SSH_CONNECTION: sshConnection, USER: "spark" },
        });

        expect(lines?.[2]).toBe("      ssh -L 18790:127.0.0.1:18790 spark@<host>");
        // No socket IP and no inferred -p port from the (untrusted) SSH_CONNECTION.
        expect(lines?.join("\n")).not.toContain("10.6.76.40");
        expect(lines?.join("\n")).not.toContain("10.10.0.5");
        expect(lines?.join("\n")).not.toContain("-p ");
      }
    });

    it("renders an explicitly supplied destination verbatim (#5925)", () => {
      const lines = buildSshForwardHintLines({
        port: 18790,
        destination: "spark-host",
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
      });

      expect(lines?.[2]).toBe("      ssh -L 18790:127.0.0.1:18790 spark@spark-host");
    });

    it("falls back to the <host> placeholder for an unsafe explicit destination", () => {
      const lines = buildSshForwardHintLines({
        port: 18790,
        destination: "evil; rm -rf /",
        env: { SSH_CONNECTION: "10.0.0.9 51000 10.6.76.40 22", USER: "spark" },
      });

      expect(lines?.[2]).toBe("      ssh -L 18790:127.0.0.1:18790 spark@<host>");
    });

    it("falls back to placeholders when user is unavailable", () => {
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

      expect(lines?.[2]).toBe("      ssh -L 18790:127.0.0.1:18790 <user>@<host>");
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
        "    ssh -L 18790:127.0.0.1:18790 spark@<host>",
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
