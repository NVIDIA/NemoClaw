// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
}));

import {
  classifyCredentialResolutionProbe,
  credentialResolutionWarning,
  MCP_PROBE_CONTROL_BEARER,
  MCP_PROBE_CONTROL_EXIT_MARKER,
  MCP_PROBE_CONTROL_HTTP_MARKER,
  MCP_PROBE_EXIT_MARKER,
  MCP_PROBE_HTTP_MARKER,
  probeCredentialResolution,
} from "./mcp-bridge-resolution-probe";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

const readyProbe = {
  policyGatewayPresent: true,
  providerAttached: true,
  providerCredentialReady: true,
} as const;

function probeStdout(
  parts: {
    httpStatus?: number;
    curlExit: number;
    controlHttpStatus?: number;
    controlExit?: number;
  },
  resultMarker?: string,
): string {
  const nonce = resultMarker ? `${resultMarker}:` : "";
  return [
    "",
    ...(parts.httpStatus !== undefined
      ? [`${MCP_PROBE_HTTP_MARKER}${nonce}${parts.httpStatus}`]
      : []),
    `${MCP_PROBE_EXIT_MARKER}${nonce}${parts.curlExit}`,
    ...(parts.controlHttpStatus !== undefined
      ? [`${MCP_PROBE_CONTROL_HTTP_MARKER}${nonce}${parts.controlHttpStatus}`]
      : []),
    ...(parts.controlExit !== undefined
      ? [`${MCP_PROBE_CONTROL_EXIT_MARKER}${nonce}${parts.controlExit}`]
      : []),
  ].join("\n");
}

beforeEach(() => {
  mocks.executeSandboxCommand.mockReset();
});

describe("MCP credential-resolution probe classification", () => {
  it("classifies placeholder 2xx with rejected control as resolved on the wire (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({
          httpStatus: 200,
          curlExit: 0,
          controlHttpStatus: 401,
          controlExit: 0,
        }),
        stderr: "",
      },
      baseEntry,
    );
    expect(probe).toEqual({ ok: true, httpStatus: 200, controlHttpStatus: 401 });
  });

  it("classifies identical placeholder and control rejections as inconclusive with both hypotheses (#6379)", () => {
    for (const httpStatus of [400, 401, 403]) {
      const probe = classifyCredentialResolutionProbe(
        {
          status: 0,
          stdout: probeStdout({
            httpStatus,
            curlExit: 0,
            controlHttpStatus: httpStatus,
            controlExit: 0,
          }),
          stderr: "",
        },
        baseEntry,
      );
      expect(probe.ok).toBeNull();
      expect(probe.httpStatus).toBe(httpStatus);
      expect(probe.controlHttpStatus).toBe(httpStatus);
      expect(probe.detail).toContain("rejected identically");
      expect(probe.detail).toContain("expired or revoked credential");
    }
  });

  it("classifies identical 5xx responses as indeterminate endpoint failure (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({
          httpStatus: 500,
          curlExit: 0,
          controlHttpStatus: 500,
          controlExit: 0,
        }),
        stderr: "",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("failed identically");
  });

  it("never reports differing non-2xx rejections as verified resolution (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({
          httpStatus: 401,
          curlExit: 0,
          controlHttpStatus: 400,
          controlExit: 0,
        }),
        stderr: "",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("differing rejections do not prove resolution");
  });

  it("names request validation among the hypotheses for identical 400 rejections (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({
          httpStatus: 400,
          curlExit: 0,
          controlHttpStatus: 400,
          controlExit: 0,
        }),
        stderr: "",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("request validation");
  });

  it("classifies dual 2xx as an endpoint that does not enforce authentication (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({
          httpStatus: 200,
          curlExit: 0,
          controlHttpStatus: 200,
          controlExit: 0,
        }),
        stderr: "",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("does not enforce authentication");
  });

  it("classifies differing non-auth statuses as indeterminate (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({
          httpStatus: 400,
          curlExit: 0,
          controlHttpStatus: 401,
          controlExit: 0,
        }),
        stderr: "",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("known-good host");
  });

  it("classifies a failed control probe as indeterminate (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({ httpStatus: 401, curlExit: 0, controlExit: 28 }),
        stderr: "",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("control probe failed");
  });

  it("classifies a CONNECT-level proxy 403 as an indeterminate policy denial (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({ curlExit: 56 }),
        stderr: "curl: (56) CONNECT tunnel failed, response 403",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("CONNECT 403");
  });

  it("classifies a CONNECT-level proxy 503 as unavailable TLS termination (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: probeStdout({ curlExit: 56 }),
        stderr: "curl: (56) CONNECT tunnel failed, response 503",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("CONNECT 503");
    expect(probe.detail).toContain("ephemeral CA initialization");
  });

  it("classifies curl exit 28 as an indeterminate probe timeout (#6379)", () => {
    const probe = classifyCredentialResolutionProbe(
      { status: 0, stdout: probeStdout({ curlExit: 28 }), stderr: "" },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(probe.detail).toContain("timed out");
  });

  it("classifies a missing command result as sandbox unreachable (#6379)", () => {
    expect(classifyCredentialResolutionProbe(null, baseEntry)).toEqual({
      ok: null,
      detail: "sandbox unreachable",
    });
  });

  it("never includes endpoint response text in the verdict (#6379)", () => {
    const body = '{"error":"bad token ghp_super-secret-value-1234567890"}';
    const probe = classifyCredentialResolutionProbe(
      {
        status: 0,
        stdout: `${probeStdout({ httpStatus: 401, curlExit: 0, controlHttpStatus: 401, controlExit: 0 })}\n${body}`,
        stderr: "",
      },
      baseEntry,
    );
    expect(probe.ok).toBeNull();
    expect(JSON.stringify(probe)).not.toContain("ghp_super-secret-value-1234567890");
  });
});

describe("MCP credential-resolution probe execution gates", () => {
  it("fails closed before sandbox traffic unless policy and provider readiness are all true (#6379)", () => {
    const cases = [
      [{ ...readyProbe, policyGatewayPresent: false }, "effective gateway policy"],
      [{ ...readyProbe, policyGatewayPresent: null }, "could not be inspected"],
      [{ ...readyProbe, providerAttached: false }, "not attached"],
      [{ ...readyProbe, providerAttached: null }, "attachment could not be inspected"],
      [{ ...readyProbe, providerCredentialReady: false }, "does not match"],
    ] as const;

    for (const [readiness, expectedDetail] of cases) {
      const probe = probeCredentialResolution("alpha", baseEntry, "mcporter", readiness);
      expect(probe).toMatchObject({ ok: null });
      expect(probe.detail).toContain(expectedDetail);
    }
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("skips without contacting the sandbox when the adapter is not declared (#6379)", () => {
    const probe = probeCredentialResolution("alpha", baseEntry, undefined, readyProbe);
    expect(probe).toEqual({ ok: null, detail: "MCP adapter is not declared" });
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("skips without contacting the sandbox while an add transaction is incomplete (#6379)", () => {
    const probe = probeCredentialResolution(
      "alpha",
      { ...baseEntry, addState: "preflighted" },
      "mcporter",
      readyProbe,
    );
    expect(probe).toEqual({ ok: null, detail: "add transaction incomplete" });
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("skips without contacting the sandbox when the stored URL is unsafe (#6379)", () => {
    const probe = probeCredentialResolution(
      "alpha",
      { ...baseEntry, url: "http://api.githubcopilot.com/mcp/" },
      "mcporter",
      readyProbe,
    );
    expect(probe).toEqual({ ok: null, detail: "no credential binding or safe endpoint to probe" });
    expect(mocks.executeSandboxCommand).not.toHaveBeenCalled();
  });

  it("executes the probe in the sandbox and classifies the outcome (#6379)", () => {
    mocks.executeSandboxCommand.mockImplementation((_sandboxName: string, command: string) => {
      const resultMarker = command.match(/__NEMOCLAW_SANDBOX_EXEC_STARTED___[0-9a-f]{32}/)?.[0];
      return {
        status: 0,
        stdout: [
          resultMarker,
          probeStdout(
            { httpStatus: 200, curlExit: 0, controlHttpStatus: 401, controlExit: 0 },
            resultMarker,
          ),
        ].join("\n"),
        stderr: "",
      };
    });
    const probe = probeCredentialResolution("alpha", baseEntry, "mcporter", readyProbe);
    expect(probe).toEqual({ ok: true, httpStatus: 200, controlHttpStatus: 401 });
    expect(mocks.executeSandboxCommand).toHaveBeenCalledTimes(1);
    const [, command] = mocks.executeSandboxCommand.mock.calls[0];
    expect(command).toContain("openshell:resolve:env:GITHUB_TOKEN");
    expect(command).toContain(MCP_PROBE_CONTROL_BEARER);
  });
});

describe("MCP credential-resolution warning", () => {
  it("warns on identical auth rejections with both hypotheses and the OpenShell host remediation (#6379)", () => {
    const warning = credentialResolutionWarning("GITHUB_TOKEN", {
      ok: null,
      httpStatus: 403,
      controlHttpStatus: 403,
    });
    expect(warning).toContain("openshell:resolve:env:GITHUB_TOKEN");
    expect(warning).toContain("identically (HTTP 403)");
    expect(warning).toContain("If the stored credential is confirmed valid");
    expect(warning).toContain("OpenShell issue 2161");
  });

  it("keeps the identical-400 warning explicitly inconclusive with the request-validation hypothesis (#6379)", () => {
    const warning = credentialResolutionWarning("GITHUB_TOKEN", {
      ok: null,
      httpStatus: 400,
      controlHttpStatus: 400,
    });
    expect(warning).toContain("inconclusive even with a valid stored credential");
    expect(warning).toContain("request validation");
    expect(warning).toContain("known-good host");
    expect(warning).not.toContain("the OpenShell host is not rewriting");
  });

  it("stays silent for verified, differing, non-auth 4xx, and 5xx outcomes (#6379)", () => {
    expect(
      credentialResolutionWarning("GITHUB_TOKEN", {
        ok: true,
        httpStatus: 200,
        controlHttpStatus: 401,
      }),
    ).toBeUndefined();
    expect(
      credentialResolutionWarning("GITHUB_TOKEN", {
        ok: null,
        httpStatus: 400,
        controlHttpStatus: 401,
      }),
    ).toBeUndefined();
    expect(
      credentialResolutionWarning("GITHUB_TOKEN", {
        ok: null,
        httpStatus: 404,
        controlHttpStatus: 404,
      }),
    ).toBeUndefined();
    expect(
      credentialResolutionWarning("GITHUB_TOKEN", {
        ok: null,
        httpStatus: 500,
        controlHttpStatus: 500,
      }),
    ).toBeUndefined();
  });
});
