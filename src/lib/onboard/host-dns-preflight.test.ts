// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Host DNS preflight (#4784): the CLI process must be able to resolve the
// provider endpoint over port 53. A host OUTPUT chain that drops tcp/udp:53
// lets the container DNS probe pass while later provider validation dies with
// `curl: (6) Could not resolve host: integrate.api.nvidia.com`. These tests
// cover the host-side probe (preflight.ts) plus the gate and remediation that
// surface it before provider validation (bridge-dns-preflight.ts).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertHostDnsHealthy,
  printHostDnsRemediation,
} from "../../../dist/lib/onboard/bridge-dns-preflight";
import { isFatalHostDnsProbeFailure, probeHostDns } from "../../../dist/lib/onboard/preflight";

describe("probeHostDns (#4784)", () => {
  // The probe runs `node -e <resolver-script> <hostname>`. Inject a
  // structured execution so the test never spawns node or touches DNS.
  const exec = (over: Record<string, unknown>) => () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    error: null,
    ...over,
  });

  it("returns ok when the resolver answers (HOSTDNS_OK on stdout)", () => {
    const result = probeHostDns({
      runProbeImpl: exec({ stdout: "HOSTDNS_OK 1.2.3.4,5.6.7.8", exitCode: 0 }),
    });
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe("integrate.api.nvidia.com");
    expect(result.reason).toBeUndefined();
    expect(isFatalHostDnsProbeFailure(result)).toBe(false);
  });

  it("flags servers_unreachable on ECONNREFUSED — the host OUTPUT-chain DNS block (#4784)", () => {
    const result = probeHostDns({
      runProbeImpl: exec({ stderr: "HOSTDNS_ERR ECONNREFUSED", exitCode: 3 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("servers_unreachable");
    expect(result.details).toContain("ECONNREFUSED");
    expect(isFatalHostDnsProbeFailure(result)).toBe(true);
  });

  it("flags servers_unreachable on ETIMEOUT (silently dropped UDP:53)", () => {
    const result = probeHostDns({
      runProbeImpl: exec({ stderr: "HOSTDNS_ERR ETIMEOUT", exitCode: 3 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("servers_unreachable");
    expect(isFatalHostDnsProbeFailure(result)).toBe(true);
  });

  it("flags servers_unreachable on EAI_AGAIN — the getaddrinfo signature of a blocked resolver (#4784)", () => {
    // `dns.lookup` (getaddrinfo) returns EAI_AGAIN when the stub/upstream
    // resolver is unreachable, which is what the iptables OUTPUT-chain
    // port-53 DROP produces in practice.
    const result = probeHostDns({
      runProbeImpl: exec({ stderr: "HOSTDNS_ERR EAI_AGAIN", exitCode: 3 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("servers_unreachable");
    expect(isFatalHostDnsProbeFailure(result)).toBe(true);
  });

  it("flags resolution_failed (fatal) on ENOTFOUND for the always-present provider host", () => {
    const result = probeHostDns({
      runProbeImpl: exec({ stderr: "HOSTDNS_ERR ENOTFOUND", exitCode: 3 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("resolution_failed");
    expect(isFatalHostDnsProbeFailure(result)).toBe(true);
  });

  it("flags timeout when the child prints the inner-timeout marker", () => {
    const result = probeHostDns({
      runProbeImpl: exec({ stderr: "HOSTDNS_TIMEOUT", exitCode: 2 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(isFatalHostDnsProbeFailure(result)).toBe(true);
  });

  it("flags timeout when the spawn itself times out (signal/ETIMEDOUT)", () => {
    const result = probeHostDns({
      runProbeImpl: exec({ stderr: "", exitCode: null, signal: "SIGTERM", timedOut: true }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(isFatalHostDnsProbeFailure(result)).toBe(true);
  });

  it("stays inconclusive (error, non-fatal) when node could not be spawned", () => {
    const result = probeHostDns({
      runProbeImpl: exec({
        stderr: "spawn node ENOENT",
        exitCode: null,
        error: "spawn node ENOENT",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");
    // Inconclusive: never abort onboarding on a probe-infra failure.
    expect(isFatalHostDnsProbeFailure(result)).toBe(false);
  });

  it("stays inconclusive on an unknown c-ares error code", () => {
    const result = probeHostDns({
      runProbeImpl: exec({ stderr: "HOSTDNS_ERR ESOMETHINGWEIRD", exitCode: 3 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");
    expect(isFatalHostDnsProbeFailure(result)).toBe(false);
  });

  it("resolves a caller-provided hostname", () => {
    const result = probeHostDns({
      hostname: "example.com",
      runProbeImpl: exec({ stdout: "HOSTDNS_OK 93.184.216.34", exitCode: 0 }),
    });
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe("example.com");
  });

  it("rejects a hostname with shell/JS metacharacters", () => {
    expect(() => probeHostDns({ hostname: "evil.com; rm -rf /" })).toThrow(/plain DNS name/);
  });
});

describe("printHostDnsRemediation (#4784)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains the host-vs-container DNS distinction and the iptables OUTPUT cause", () => {
    const messages: string[] = [];
    vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      messages.push(String(arg ?? ""));
    });
    printHostDnsRemediation({ platform: "linux", isWsl: false }, "integrate.api.nvidia.com");
    const blob = messages.join("\n");
    expect(blob).toContain("could not resolve integrate.api.nvidia.com");
    expect(blob).toContain("Container DNS may still look healthy");
    expect(blob).toContain("curl: (6) Could not resolve host: integrate.api.nvidia.com");
    expect(blob).toContain("--dport 53");
    expect(blob).toContain("NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT=1");
    expect(blob).toContain("#4784");
  });

  it("adds a Windows/WSL firewall hint only on those platforms", () => {
    const winMessages: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      winMessages.push(String(arg ?? ""));
    });
    printHostDnsRemediation({ platform: "win32", isWsl: false });
    expect(winMessages.join("\n")).toContain("Windows Firewall");
    errSpy.mockRestore();

    const linuxMessages: string[] = [];
    vi.spyOn(console, "error").mockImplementation((arg?: unknown) => {
      linuxMessages.push(String(arg ?? ""));
    });
    printHostDnsRemediation({ platform: "linux", isWsl: false });
    expect(linuxMessages.join("\n")).not.toContain("Windows Firewall");
  });
});

describe("assertHostDnsHealthy (#4784)", () => {
  const host = { platform: "linux", isWsl: false } as Parameters<typeof assertHostDnsHealthy>[0];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the success line and does not exit when host DNS resolves", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((arg?: unknown) => logs.push(String(arg ?? "")));
    const exit = vi.fn();
    assertHostDnsHealthy(host, {
      env: {},
      nonInteractive: true,
      exit,
      probeHostDnsImpl: () => ({ ok: true, hostname: "integrate.api.nvidia.com" }),
    });
    expect(logs.join("\n")).toContain("✓ Host DNS resolution works");
    expect(exit).not.toHaveBeenCalled();
  });

  it("aborts (exit 1) with remediation when host DNS is blocked but container DNS would pass (#4784)", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((arg?: unknown) =>
      errors.push(String(arg ?? "")),
    );
    const exit = vi.fn();
    assertHostDnsHealthy(host, {
      env: {},
      nonInteractive: true,
      exit,
      probeHostDnsImpl: () => ({
        ok: false,
        hostname: "integrate.api.nvidia.com",
        reason: "servers_unreachable",
        details: "dns.resolve integrate.api.nvidia.com: ECONNREFUSED",
      }),
    });
    expect(exit).toHaveBeenCalledWith(1);
    const blob = errors.join("\n");
    expect(blob).toContain("✗ Host DNS resolution failed");
    expect(blob).toContain("could not resolve integrate.api.nvidia.com");
    expect(blob).toContain("--dport 53");
  });

  it("aborts on resolution_failed with the resolver-answered wording", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((arg?: unknown) =>
      errors.push(String(arg ?? "")),
    );
    const exit = vi.fn();
    assertHostDnsHealthy(host, {
      env: {},
      nonInteractive: true,
      exit,
      probeHostDnsImpl: () => ({
        ok: false,
        hostname: "integrate.api.nvidia.com",
        reason: "resolution_failed",
        details: "dns.resolve integrate.api.nvidia.com: ENOTFOUND",
      }),
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("resolver answered, no record");
  });

  it("warns and continues (no exit) when the probe is inconclusive", () => {
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((arg?: unknown) => warns.push(String(arg ?? "")));
    const exit = vi.fn();
    assertHostDnsHealthy(host, {
      env: {},
      nonInteractive: true,
      exit,
      probeHostDnsImpl: () => ({
        ok: false,
        hostname: "integrate.api.nvidia.com",
        reason: "error",
        details: "spawn node ENOENT",
      }),
    });
    expect(exit).not.toHaveBeenCalled();
    expect(warns.join("\n")).toContain("Host DNS probe inconclusive");
  });

  it("skips the check (no exit, no probe) when NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT is set", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((arg?: unknown) => logs.push(String(arg ?? "")));
    const exit = vi.fn();
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    assertHostDnsHealthy(host, {
      env: { NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT: "1" },
      exit,
      probeHostDnsImpl: probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Host DNS resolution check skipped");
  });

  it("skips silently (no probe, no exit) when a non-NVIDIA provider is selected (codex P2)", () => {
    const exit = vi.fn();
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    // A user who picked a local/non-NVIDIA provider must not be blocked by
    // NVIDIA-domain DNS even if their host cannot resolve it — including in
    // non-interactive mode where the choice is explicit.
    for (const provider of ["ollama", "openai", "anthropic", "vllm", "custom"]) {
      assertHostDnsHealthy(host, {
        env: { NEMOCLAW_PROVIDER: provider },
        nonInteractive: true,
        exit,
        probeHostDnsImpl: probe,
      });
    }
    expect(probe).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("skips an unset provider in interactive mode (provider not yet chosen — codex P2)", () => {
    const exit = vi.fn();
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    // Fresh interactive onboarding hits preflight before the provider menu;
    // it may end up on Ollama/vLLM, so an NVIDIA-DNS block must not abort here.
    assertHostDnsHealthy(host, {
      env: {},
      nonInteractive: false,
      exit,
      probeHostDnsImpl: probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("runs for an unset provider only in non-interactive mode (NVIDIA Endpoints default)", () => {
    const exit = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    assertHostDnsHealthy(host, {
      env: {},
      nonInteractive: true,
      exit,
      probeHostDnsImpl: probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("runs for explicit NVIDIA Endpoints provider keys (build/cloud/routed) in non-interactive mode", () => {
    const exit = vi.fn();
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const provider of ["build", "cloud", "routed"]) {
      const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
      assertHostDnsHealthy(host, {
        env: { NEMOCLAW_PROVIDER: provider },
        nonInteractive: true,
        exit,
        probeHostDnsImpl: probe,
      });
      expect(probe).toHaveBeenCalledTimes(1);
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it("ignores NEMOCLAW_PROVIDER in interactive mode (onboard ignores it there too)", () => {
    const exit = vi.fn();
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    // Interactive onboarding ignores NEMOCLAW_PROVIDER and shows the menu, so
    // we must not assume NVIDIA from it before the user has chosen.
    assertHostDnsHealthy(host, {
      env: { NEMOCLAW_PROVIDER: "build" },
      nonInteractive: false,
      exit,
      probeHostDnsImpl: probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("skips an explicit local NIM provider (nim-local) in non-interactive mode", () => {
    const exit = vi.fn();
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    // `nim-local` runs NIM locally and validates against localhost, not
    // integrate.api.nvidia.com, so the NVIDIA host DNS probe must not gate it.
    assertHostDnsHealthy(host, {
      env: { NEMOCLAW_PROVIDER: "nim-local" },
      nonInteractive: true,
      exit,
      probeHostDnsImpl: probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("skips when the provider host is reached via a configured HTTPS proxy (codex P2 proxy)", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((arg?: unknown) => logs.push(String(arg ?? "")));
    const exit = vi.fn();
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    assertHostDnsHealthy(host, {
      env: { NEMOCLAW_PROVIDER: "build", HTTPS_PROXY: "http://proxy.corp:3128" },
      nonInteractive: true,
      exit,
      probeHostDnsImpl: probe,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("HTTPS proxy configured");
  });

  it("still runs when NO_PROXY exempts the provider host from the proxy", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.fn();
    const probe = vi.fn(() => ({ ok: true as const, hostname: "integrate.api.nvidia.com" }));
    assertHostDnsHealthy(host, {
      env: {
        NEMOCLAW_PROVIDER: "build",
        HTTPS_PROXY: "http://proxy.corp:3128",
        NO_PROXY: ".nvidia.com",
      },
      nonInteractive: true,
      exit,
      probeHostDnsImpl: probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
