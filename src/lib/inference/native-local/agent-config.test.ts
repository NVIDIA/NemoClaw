// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { nativeLocalCredentialReference } from "./agent-config";
import { nativeLocalCredentialReference as hostCredentialReference } from "./model-router";
import * as blueprint from "../../core/model-router-port";

const endpoint = "http://host.openshell.internal:43123/team/v1";
const reference = "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN";
const handle = "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN";

describe("native local image credential projection", () => {
  it.each([handle, `openshell:resolve:env:s${"a".repeat(64)}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`])(
    "projects an issued handle for a configured Router without reading the host blueprint: %s",
    (issued) => {
      const loader = vi.spyOn(blueprint, "loadBlueprintProfile").mockImplementation(() => {
        throw new Error("The host blueprint is unavailable in an image");
      });
      expect(nativeLocalCredentialReference("team-router", endpoint, undefined, issued)).toBe(
        reference,
      );
      expect(loader).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "",
    "raw-key",
    reference,
    "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:sabc_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    `${handle}\n`,
    `raw\n${handle}`,
    `${handle}\nraw`,
  ])("does not project a Router credential from an invalid handle: %s", (issued) => {
    expect(nativeLocalCredentialReference("team-router", endpoint, undefined, issued)).toBeNull();
  });

  it.each([
    "http://host.docker.internal:43123/team/v1",
    "http://10.1.2.3:43123/team/v1",
    "http://127.0.0.1:43123/team/v1",
    "http://169.254.169.254:43123/team/v1",
    "https://host.openshell.internal:43123/team/v1",
    "http://host.openshell.internal:80/team/v1",
    `${endpoint}?token=hidden`,
    `${endpoint}#fragment`,
    "http://user:pass@host.openshell.internal:43123/team/v1",
    `${endpoint}%2fadmin`,
  ])("does not use an issued Router handle at another endpoint shape: %s", (url) => {
    expect(nativeLocalCredentialReference("team-router", url, undefined, handle)).toBeNull();
  });

  it("keeps host Router admission bound to its configured name, port, and path", () => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TOKEN", handle);
    vi.spyOn(blueprint, "loadBlueprintProfile").mockReturnValue({
      provider_name: "team-router",
      endpoint: "http://localhost:43123/team/v1",
      model: "selected",
      router: { enabled: true, port: 43123 },
    });
    expect(hostCredentialReference("team-router", endpoint)).toBe(reference);
    expect(hostCredentialReference("other-router", endpoint)).toBeNull();
    expect(hostCredentialReference("team-router", endpoint.replace("43123", "43124"))).toBeNull();
    expect(hostCredentialReference("team-router", endpoint.replace("team/v1", "admin"))).toBeNull();
  });
});
