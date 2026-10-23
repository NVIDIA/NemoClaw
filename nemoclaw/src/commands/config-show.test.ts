// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOnboardConfig } from "../onboard/config.js";
import { slashConfigShow } from "./config-show.js";

vi.mock("../onboard/config.js", () => ({ loadOnboardConfig: vi.fn() }));

describe("commands/config-show", () => {
  beforeEach(() => {
    vi.mocked(loadOnboardConfig).mockReturnValue(null);
  });

  it("shows missing native fields without an onboarding fallback", () => {
    vi.mocked(loadOnboardConfig).mockReturnValue({
      profile: "default",
      onboardedAt: "2026-09-23",
    });
    const result = slashConfigShow({});
    expect(result.text).toContain("Model:       (not configured)");
    expect(result.text).toContain("Auth token:  (not configured)");
    expect(result.text).toContain("Onboarded:   2026-09-23");
  });

  it("shows native route edits without requiring onboarding metadata", () => {
    const result = slashConfigShow({
      agents: { defaults: { model: "edited/model" } },
      models: {
        providers: {
          edited: {
            baseUrl: "https://edited.example/v1",
            apiKey: { source: "env", id: "EDITED_KEY", provider: "default" },
          },
        },
      },
    });
    expect(result.text).toContain("https://edited.example/v1");
    expect(result.text).toContain("Inference:   edited");
    expect(result.text).toContain("Model:       edited/model");
    expect(result.text).toContain("$EDITED_KEY (set via env var)");
    expect(result.text).toContain("Profile:     (not recorded)");
  });

  it("does not expose native literal credentials or URL secrets", () => {
    const result = slashConfigShow({
      agents: { defaults: { model: "inference/model" } },
      models: {
        providers: {
          inference: {
            baseUrl: "https://user:password@edited.example/v1?token=secret#fragment",
            apiKey: "private-literal",
          },
        },
      },
    });
    expect(result.text).toContain("Auth token:  (configured)");
    expect(result.text).toContain("https://edited.example/v1");
    expect(result.text).not.toMatch(/password|secret|fragment|private-literal/);
  });

  it("points to the sandbox-first host config command", () => {
    expect(slashConfigShow({}).text).toContain("Use `nemoclaw <sandbox> config get`");
  });
});
