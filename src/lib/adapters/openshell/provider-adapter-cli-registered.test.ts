// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { it, expect, vi } from "vitest";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import { createCliOpenShellProviderAdapter } from "./provider-adapter-cli";
import { namedOpenShellGateway } from "./sandbox-observer";
function captured(status: number, stdout: string) {
  return { status, stdout, stderr: "" };
}
it("reads operator inference projection only when explicitly requested", async () => {
  const profile = registeredInferenceFixture().profile;
  const run = vi.fn(() => captured(0, JSON.stringify(profile)));
  const adapter = createCliOpenShellProviderAdapter({ run, environment: {} });
  const request = {
    target: namedOpenShellGateway("nemoclaw-18080"),
    profileType: "operator-inference",
  };
  await expect(adapter.inspectProviderProfile(request)).resolves.toEqual({
    ok: true,
    value: { credentialKeys: ["VENDOR_API_KEY"] },
  });
  await expect(
    adapter.inspectProviderProfile({ ...request, includeInferenceProjection: true }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      inference: {
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        credentials: [
          { envVars: ["VENDOR_API_KEY"], authStyle: "bearer", headerName: "authorization" },
        ],
        endpoints: [{ host: "native.example", port: 443 }],
      },
    },
  });
  expect(run).toHaveBeenLastCalledWith(
    [
      "provider",
      "profile",
      "-g",
      "nemoclaw-18080",
      "export",
      "operator-inference",
      "--output",
      "json",
    ],
    expect.any(Object),
  );
});
