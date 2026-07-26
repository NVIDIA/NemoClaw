// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatBuildFailureDiagnostics } from "./sandbox-base-image";

describe("sandbox base-image build diagnostics", () => {
  it("surfaces stderr build diagnostics on failure (#3584)", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "the --mount option requires BuildKit",
      stdout: "",
    });
    expect(output).toContain("the --mount option requires BuildKit");
  });

  it("surfaces stdout-only build diagnostics because BuildKit can put errors there per Codex review (#3584)", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "",
      stdout:
        'ERROR: failed to solve: process "/bin/sh -c apt-get install" did not complete successfully',
    });
    expect(output).toContain("ERROR: failed to solve");
  });

  it("combines stderr and stdout when both carry build output", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: "build error line A",
      stdout: "build error line B",
    });
    expect(output).toBe("build error line A\nbuild error line B");
  });

  it("returns empty string when both streams are empty", () => {
    expect(formatBuildFailureDiagnostics({ stderr: "", stdout: "" })).toBe("");
    expect(formatBuildFailureDiagnostics({})).toBe("");
  });

  it("redacts captured build output before returning it", () => {
    // The runner's redact() pass strips Bearer tokens, NVIDIA API keys, etc.
    // Anything that looks like a secret in build output must not leak.
    const output = formatBuildFailureDiagnostics({
      stderr: "auth: Bearer sk-abcdef0123456789abcdef0123456789abcdef0123456789 failed",
      stdout: "",
    });
    expect(output).not.toContain("sk-abcdef0123456789abcdef0123456789abcdef0123456789");
  });

  it("redacts structured credentials and credentialed URLs in build output", () => {
    const basicCredential = Buffer.from(
      ["build-user", "build-password"].join(":"),
      "utf8",
    ).toString("base64");
    const digestResponse = ["digest", "response", "secret"].join("-");
    const cookieValue = ["session", "cookie-secret"].join("=");
    const urlPassword = ["registry", "password"].join("-");
    const queryToken = ["query", "token", "secret"].join("-");
    const terminalLink = ["https://", "terminal.example.test", "/hidden"].join("");
    const homePath = path.join(os.homedir(), ".docker", "config.json");
    const temporaryPath = path.join(os.tmpdir(), "nemoclaw-build", "metadata.json");
    const output = formatBuildFailureDiagnostics({
      stderr: [
        `Authorization: Basic ${basicCredential}`,
        `Proxy-Authorization: Digest username="build-user", response="${digestResponse}"`,
        `Cookie: ${cookieValue}`,
        `failed to fetch https://build-user:${urlPassword}@registry.example.test/v2/layer?token=${queryToken}`,
        `terminal link: \u001b]8;;${terminalLink}\u0007open\u001b]8;;\u0007`,
        `home config: ${homePath}`,
        `temporary metadata: ${temporaryPath}`,
      ].join("\n"),
    });

    expect(output).not.toContain(basicCredential);
    expect(output).not.toContain(digestResponse);
    expect(output).not.toContain(cookieValue);
    expect(output).not.toContain(urlPassword);
    expect(output).not.toContain(queryToken);
    expect(output).not.toContain(terminalLink);
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain(homePath);
    expect(output).not.toContain(temporaryPath);
    expect(output).toContain("Authorization: Basic <REDACTED>");
    expect(output).toContain("Proxy-Authorization: Digest <REDACTED>");
    expect(output).toContain("Cookie: <REDACTED>");
    expect(output).toContain("****");
  });

  it("bounds captured build diagnostics before returning them", () => {
    const output = formatBuildFailureDiagnostics({ stderr: "x".repeat(10_000) });

    expect(output.length).toBeLessThan(8_100);
    expect(output.endsWith("[diagnostic truncated]")).toBe(true);
  });

  it("surfaces a redacted spawn failure cause", () => {
    const token = ["spawn", "secret", "token"].join("-");
    const output = formatBuildFailureDiagnostics({
      error: new Error(`spawn docker EACCES: Bearer ${token}`),
    });

    expect(output).toContain("spawn docker EACCES");
    expect(output).not.toContain(token);
  });

  it("accepts Buffer streams from spawnSync", () => {
    const output = formatBuildFailureDiagnostics({
      stderr: Buffer.from("buffered build error", "utf8"),
      stdout: null,
    });
    expect(output).toContain("buffered build error");
  });
});
