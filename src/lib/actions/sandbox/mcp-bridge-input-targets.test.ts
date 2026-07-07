// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns/promises";

import { describe, expect, it, vi } from "vitest";

import { addMcpBridge, normalizeMcpServerUrl } from "./mcp-bridge";
import { validateMcpServerUrlResolvedTarget } from "./mcp-bridge-validation";

describe("MCP URL target validation", () => {
  it("sorts and deduplicates public DNS pins deterministically", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ] as never);
    try {
      await expect(
        validateMcpServerUrlResolvedTarget(new URL("https://mcp.example.test/mcp")),
      ).resolves.toEqual(["2606:4700:4700::1111", "8.8.8.8"]);
    } finally {
      lookup.mockRestore();
    }
  });

  it("rejects private DNS answers and OpenShell host aliases before DNS", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    try {
      await expect(
        validateMcpServerUrlResolvedTarget(new URL("https://mcp.example.test/mcp")),
      ).rejects.toThrow(/resolves to private, local, or special-use address '127\.0\.0\.1'/);
      await expect(
        validateMcpServerUrlResolvedTarget(new URL("https://host.openshell.internal:31337/mcp")),
      ).rejects.toThrow(/does not expose an attested driver gateway address/);
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      lookup.mockRestore();
    }
  });

  it("rejects hostile OpenShell alias registrations before sandbox or network side effects", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    try {
      for (const host of [
        "host.openshell.internal",
        "host.docker.internal",
        "host.containers.internal",
      ]) {
        await expect(
          addMcpBridge("missing-sandbox", {
            server: "local",
            url: `https://${host}:31337/mcp`,
            env: [{ name: "SAFE_MCP_TOKEN", value: "host-only-secret" }],
          }),
        ).rejects.toThrow(/does not expose an attested driver gateway address/);
      }
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("rejects malformed percent paths before DNS or sandbox side effects", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    try {
      for (const path of ["%", "%GG", "%2"]) {
        await expect(
          addMcpBridge("missing-sandbox", {
            server: "malformed",
            url: `https://mcp.example.test/${path}`,
            env: [{ name: "SAFE_MCP_TOKEN", value: "host-only-secret" }],
          }),
        ).rejects.toThrow(/percent characters/);
      }
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("rejects local, private, and OpenShell host-alias URL targets", () => {
    expect(() => normalizeMcpServerUrl("https://localhost:31337/mcp")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://127.0.0.1:31337/mcp")).toThrow(
      /private, local, or special-use IP/,
    );
    for (const host of ["2130706433", "0177.0.0.1", "0x7f.0.0.1", "localhost."]) {
      expect(() => normalizeMcpServerUrl(`https://${host}:31337/mcp`)).toThrow(
        /private, local, or special-use IP/,
      );
    }
    expect(() => normalizeMcpServerUrl("https://169.254.169.254/latest")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://[::1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("https://[::ffff:a00:1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("https://[::ffff:127.0.0.1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("https://[::ffff:7f00:1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("http://mcp.example.test/mcp")).toThrow(/must use https/);
    expect(normalizeMcpServerUrl("https://8.8.8.8/mcp")).toBe("https://8.8.8.8/mcp");
    expect(() => normalizeMcpServerUrl("https://[2606:4700::1]/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("http://host.openshell.internal:31337/mcp")).toThrow(
      /must use https/,
    );
    for (const host of [
      "host.openshell.internal",
      "host.openshell.internal.",
      "host.docker.internal",
      "host.containers.internal",
    ]) {
      expect(() => normalizeMcpServerUrl(`https://${host}:31337/mcp`)).toThrow(
        /does not expose an attested driver gateway address/,
      );
    }
  });
});
