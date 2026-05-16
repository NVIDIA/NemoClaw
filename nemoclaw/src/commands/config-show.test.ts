// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NemoClawOnboardConfig } from "../onboard/config.js";

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
  describeOnboardEndpoint: vi.fn(),
  describeOnboardProvider: vi.fn(),
}));

import { slashConfigShow } from "./config-show.js";
import {
  loadOnboardConfig,
  describeOnboardEndpoint,
  describeOnboardProvider,
} from "../onboard/config.js";

const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);
const mockedDescribeOnboardEndpoint = vi.mocked(describeOnboardEndpoint);
const mockedDescribeOnboardProvider = vi.mocked(describeOnboardProvider);

describe("commands/config-show", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadOnboardConfig.mockReturnValue(null);
  });

  it("shows no config message when onboard config is missing", () => {
    const result = slashConfigShow();
    expect(result.text).toContain("No configuration found");
    expect(result.text).toContain("nemoclaw onboard");
  });

  it("shows config with redacted credentials when config exists", () => {
    const config: NemoClawOnboardConfig = {
      endpointType: "build",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
      onboardedAt: "2026-04-10T14:22:00Z",
    };
    mockedLoadOnboardConfig.mockReturnValue(config);
    mockedDescribeOnboardEndpoint.mockReturnValue("build (https://integrate.api.nvidia.com/v1)");
    mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoint API");

    const result = slashConfigShow();
    expect(result.text).toContain("NemoClaw Config");
    expect(result.text).toContain("build (https://integrate.api.nvidia.com/v1)");
    expect(result.text).toContain("$NVIDIA_API_KEY");
    expect(result.text).toContain("NVIDIA Endpoint API");
    expect(result.text).toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(result.text).toContain("2026-04-10T14:22:00Z");
  });

  it("does not expose raw credential values", () => {
    const config: NemoClawOnboardConfig = {
      endpointType: "build",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
      onboardedAt: "2026-04-10T14:22:00Z",
    };
    mockedLoadOnboardConfig.mockReturnValue(config);
    mockedDescribeOnboardEndpoint.mockReturnValue("build");
    mockedDescribeOnboardProvider.mockReturnValue("NVIDIA");

    const result = slashConfigShow();
    // Should show env var name, not the actual key value
    expect(result.text).toContain("$NVIDIA_API_KEY");
    expect(result.text).not.toContain("nvapi-");
  });

  it("includes NCP partner when set", () => {
    const config: NemoClawOnboardConfig = {
      endpointType: "ncp",
      endpointUrl: "https://partner.example.com/v1",
      ncpPartner: "PartnerCo",
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
      onboardedAt: "2026-04-10T14:22:00Z",
    };
    mockedLoadOnboardConfig.mockReturnValue(config);
    mockedDescribeOnboardEndpoint.mockReturnValue("ncp (https://partner.example.com/v1)");
    mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Cloud Partner");

    const result = slashConfigShow();
    expect(result.text).toContain("NCP Partner: PartnerCo");
  });

  it("shows not configured when credentialEnv is empty", () => {
    const config: NemoClawOnboardConfig = {
      endpointType: "build",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: "default",
      credentialEnv: "",
      onboardedAt: "2026-04-10T14:22:00Z",
    };
    mockedLoadOnboardConfig.mockReturnValue(config);
    mockedDescribeOnboardEndpoint.mockReturnValue("build");
    mockedDescribeOnboardProvider.mockReturnValue("NVIDIA");

    const result = slashConfigShow();
    expect(result.text).toContain("not configured");
  });

  it("notes that config is host-only modifiable", () => {
    const config: NemoClawOnboardConfig = {
      endpointType: "build",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
      onboardedAt: "2026-04-10T14:22:00Z",
    };
    mockedLoadOnboardConfig.mockReturnValue(config);
    mockedDescribeOnboardEndpoint.mockReturnValue("build");
    mockedDescribeOnboardProvider.mockReturnValue("NVIDIA");

    const result = slashConfigShow();
    expect(result.text).toContain("host CLI");
  });
});
