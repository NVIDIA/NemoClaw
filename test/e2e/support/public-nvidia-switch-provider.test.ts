// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  PUBLIC_NVIDIA_SWITCH_MODEL,
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
  registerPublicNvidiaSwitchProvider,
  requirePublicNvidiaSwitchKey,
} from "../live/public-nvidia-switch-provider.ts";

describe("public NVIDIA inference switch provider", () => {
  it("pins the healthy public provider and model", () => {
    expect(PUBLIC_NVIDIA_SWITCH_PROVIDER).toBe("nvidia-prod");
    expect(PUBLIC_NVIDIA_SWITCH_MODEL).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(requirePublicNvidiaSwitchKey("nvapi-public-key")).toBe("nvapi-public-key");
    expect(() => requirePublicNvidiaSwitchKey("sk-hosted-key")).toThrow(/nvapi-\*/u);
  });

  it("aliases the public key only to the registered provider credential env", async () => {
    const command = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await registerPublicNvidiaSwitchProvider(
      { command } as unknown as HostCliClient,
      "nvapi-public-key",
      {
        NVIDIA_API_KEY: "must-not-be-forwarded",
        NVIDIA_INFERENCE_API_KEY: "must-be-replaced",
        OPENSHELL_GATEWAY: "nemoclaw",
        PATH: "/usr/bin",
      },
    );

    const [program, args, options] = command.mock.calls[0]!;
    expect(program).toBe("bash");
    expect(args[1]).toContain("provider get -g nemoclaw nvidia-prod");
    expect(args[1]).toContain(
      "provider create -g nemoclaw --name nvidia-prod --type nvidia --credential NVIDIA_INFERENCE_API_KEY",
    );
    expect(args[1]).toContain(
      "provider update -g nemoclaw nvidia-prod --credential NVIDIA_INFERENCE_API_KEY",
    );
    expect(options).toMatchObject({
      env: {
        NVIDIA_INFERENCE_API_KEY: "nvapi-public-key",
        OPENSHELL_GATEWAY: "nemoclaw",
        PATH: "/usr/bin",
      },
      redactionValues: ["nvapi-public-key"],
    });
    expect(options.env).not.toHaveProperty("NVIDIA_API_KEY");
  });
});
