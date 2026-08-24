// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAuthorityBoundDnsSetup = vi.hoisted(() => vi.fn(() => ({ exitCode: 0 })));

vi.mock("../../../lib/actions/dns/authority-bound-setup", () => ({
  runAuthorityBoundDnsSetup,
}));

import InternalDnsSetupProxyCommand from "./setup-proxy";

describe("internal DNS setup-proxy command", () => {
  beforeEach(() => {
    runAuthorityBoundDnsSetup.mockClear();
    runAuthorityBoundDnsSetup.mockReturnValue({ exitCode: 0 });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it("uses the registered sandbox authority when no receipt argument is present (#9833)", async () => {
    await InternalDnsSetupProxyCommand.run(["nemoclaw", "alpha"], process.cwd());

    expect(runAuthorityBoundDnsSetup).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      recordedPolicyAuthority: undefined,
      sandboxName: "alpha",
    });
  });

  it("passes the snapshot authority receipt into DNS setup (#9833)", async () => {
    await InternalDnsSetupProxyCommand.run(
      ["nemoclaw-9090", "clone", "externally-managed"],
      process.cwd(),
    );

    expect(runAuthorityBoundDnsSetup).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-9090",
      recordedPolicyAuthority: "externally-managed",
      sandboxName: "clone",
    });
  });
});
