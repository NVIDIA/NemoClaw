// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  printContainerDnsRemediation,
  printDockerBridgeContainerStartFailure,
} from "../../../dist/lib/onboard/bridge-dns-preflight";
import { setOnboardBrandingAgent } from "../../../dist/lib/onboard/branding";

describe("printDockerBridgeContainerStartFailure", () => {
  const savedInvokedAs = process.env.NEMOCLAW_INVOKED_AS;
  const savedAgent = process.env.NEMOCLAW_AGENT;
  afterEach(() => {
    setOnboardBrandingAgent(null);
    if (savedInvokedAs === undefined) {
      delete process.env.NEMOCLAW_INVOKED_AS;
    } else {
      process.env.NEMOCLAW_INVOKED_AS = savedInvokedAs;
    }
    if (savedAgent === undefined) {
      delete process.env.NEMOCLAW_AGENT;
    } else {
      process.env.NEMOCLAW_AGENT = savedAgent;
    }
    vi.restoreAllMocks();
  });

  it("uses the active CLI branding in the verify-outside hint (#3630 CodeRabbit)", () => {
    setOnboardBrandingAgent("hermes");
    process.env.NEMOCLAW_AGENT = "hermes";
    process.env.NEMOCLAW_INVOKED_AS = "nemohermes";
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printDockerBridgeContainerStartFailure({
      ok: false,
      reason: "veth_unsupported",
      details: "docker: failed to add the host <=> sandbox veth pair interfaces",
      timedOut: false,
      exitCode: 125,
      signal: null,
    });
    errSpy.mockRestore();
    const verifyLine = messages.find((line) => line.startsWith("  Verify outside"));
    expect(verifyLine).toBeDefined();
    expect(verifyLine).toContain("NemoHermes");
    expect(verifyLine).not.toContain("Verify outside NemoClaw:");
  });

  it("renders Linux daemon.json remediation without the bare-echo clobber fallback (#3630 CodeRabbit)", () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    // `printContainerDnsRemediation` only reads a few host fields; cast
    // through `unknown` so the test doesn't have to build a full
    // HostAssessment fixture.
    printContainerDnsRemediation({
      platform: "linux",
      isWsl: false,
      systemctlAvailable: true,
      runtime: "docker",
    } as unknown as Parameters<typeof printContainerDnsRemediation>[0]);
    errSpy.mockRestore();
    const blob = messages.join("\n");
    // Must NOT clobber an existing daemon.json via a bare-echo fallback.
    expect(blob).not.toMatch(/\|\|\s*echo '?\{"dns"/);
    expect(blob).not.toMatch(/echo '\{"dns":/);
    // Must direct users to install jq if missing, and create the config dir.
    expect(blob).toContain("mkdir -p /etc/docker");
    expect(blob).toContain("jq");
    expect(blob).toMatch(/install jq|apt-get install/i);
    // Must surface a manual-edit path so users without jq can still proceed.
    expect(blob).toMatch(/edit \/etc\/docker\/daemon\.json manually/);
    // Sanity: still uses `jq -n` to create new daemon.json when missing.
    expect(blob).toContain("jq -n");
    expect(blob).toMatch(/\{"dns":\["[^"]+"\]\}/);
  });

  it("renders WSL-without-systemd remediation without using systemctl steps (#3630 CodeRabbit)", () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printContainerDnsRemediation({
      platform: "linux",
      isWsl: true,
      systemctlAvailable: false,
      runtime: "docker",
    } as unknown as Parameters<typeof printContainerDnsRemediation>[0]);
    errSpy.mockRestore();
    const blob = messages.join("\n");
    expect(blob).toContain("Docker Desktop"); // step 1 still mentions Docker Desktop
    // Step 2 path on non-systemd WSL must NOT print systemctl commands.
    expect(blob).not.toContain("sudo systemctl restart systemd-resolved");
    expect(blob).not.toContain("sudo systemctl restart docker");
    expect(blob).toMatch(/service docker restart|stop the dockerd process/);
    // Still uses the safe jq merge — no bare-echo clobber.
    expect(blob).not.toMatch(/\|\|\s*echo '?\{"dns"/);
    expect(blob).toContain("mkdir -p /etc/docker");
    expect(blob).toContain("jq -n");
  });

  it("renders WSL-with-systemd remediation with the Linux systemd path (#3630 CodeRabbit)", () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printContainerDnsRemediation({
      platform: "linux",
      isWsl: true,
      systemctlAvailable: true,
      runtime: "docker",
    } as unknown as Parameters<typeof printContainerDnsRemediation>[0]);
    errSpy.mockRestore();
    const blob = messages.join("\n");
    expect(blob).toContain("sudo systemctl restart systemd-resolved");
    expect(blob).toContain("sudo systemctl restart docker");
  });

  it("uses the pinned BusyBox digest in the manual verify-fix commands (#3630 CodeRabbit)", () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printContainerDnsRemediation({
      platform: "linux",
      isWsl: false,
      systemctlAvailable: true,
      runtime: "docker",
    } as unknown as Parameters<typeof printContainerDnsRemediation>[0]);
    errSpy.mockRestore();
    const blob = messages.join("\n");
    // The manual nslookup verification must use the pinned digest, not
    // the floating `busybox:latest` tag.
    expect(blob).toMatch(/docker run --rm busybox@sha256:[0-9a-f]{64} nslookup/);
    expect(blob).not.toMatch(/docker run --rm busybox\s+nslookup/);
  });

  it("uses the pinned BusyBox digest in the verify-outside hint after a bridge failure (#3630 CodeRabbit)", () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printDockerBridgeContainerStartFailure({
      ok: false,
      reason: "veth_unsupported",
      details: "operation not supported",
      timedOut: false,
      exitCode: 125,
      signal: null,
    });
    errSpy.mockRestore();
    const blob = messages.join("\n");
    expect(blob).toMatch(/docker run --rm --network bridge busybox@sha256:[0-9a-f]{64} true/);
    expect(blob).not.toMatch(/busybox:latest true/);
  });

  it("renders macOS Docker Desktop daemon.json remediation without bare-echo clobber (#3630 CodeRabbit)", () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printContainerDnsRemediation({
      platform: "darwin",
      isWsl: false,
      systemctlAvailable: false,
      runtime: "docker-desktop",
    } as unknown as Parameters<typeof printContainerDnsRemediation>[0]);
    errSpy.mockRestore();
    const blob = messages.join("\n");
    expect(blob).not.toMatch(/\|\|\s*echo '?\{"dns"/);
    expect(blob).not.toMatch(/echo '\{"dns":/);
    expect(blob).toContain("mkdir -p ~/.docker");
    expect(blob).toMatch(/brew install jq|install jq/i);
    expect(blob).toMatch(/edit ~\/\.docker\/daemon\.json manually/);
    expect(blob).toContain("jq -n");
  });

  it("uses cliName() in the docker_daemon_unreachable rerun hint", () => {
    setOnboardBrandingAgent("hermes");
    process.env.NEMOCLAW_AGENT = "hermes";
    process.env.NEMOCLAW_INVOKED_AS = "nemohermes";
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printDockerBridgeContainerStartFailure({
      ok: false,
      reason: "docker_daemon_unreachable",
      details: "Cannot connect to the Docker daemon",
      timedOut: false,
      exitCode: null,
      signal: null,
    });
    errSpy.mockRestore();
    const rerunLine = messages.find((line) => line.includes("re-run"));
    expect(rerunLine).toBeDefined();
    expect(rerunLine).toContain("nemohermes onboard");
    expect(rerunLine).not.toMatch(/\bnemoclaw onboard\b/);
  });

  it("prints the Docker Desktop WSL integration hint for WSL daemon access failures", () => {
    const messages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printDockerBridgeContainerStartFailure(
      {
        ok: false,
        reason: "docker_daemon_unreachable",
        details: "Cannot connect to the Docker daemon",
        timedOut: false,
        exitCode: null,
        signal: null,
      },
      { isWsl: true },
    );
    errSpy.mockRestore();
    const blob = messages.join("\n");
    expect(blob).toContain("Docker Desktop > Settings > Resources > WSL integration");
    expect(blob).toContain("enable integration for this distro");
  });
});
