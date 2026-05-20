// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "../dist/lib/agent/defs.js";
import { getNameValidationGuidance, NAME_ALLOWED_FORMAT } from "../dist/lib/name-validation.js";

const {
  getDefaultSandboxNameForAgent,
  getRequestedSandboxAgentName,
  getSandboxPromptDefault,
  normalizeSandboxAgentName,
} = require("../dist/lib/onboard") as {
  getDefaultSandboxNameForAgent: (agent?: { name: string } | null) => string;
  getRequestedSandboxAgentName: (agent?: { name: string } | null) => string;
  getSandboxPromptDefault: (agent?: { name: string } | null) => string;
  normalizeSandboxAgentName: (agentName?: string | null) => string;
};

describe("onboard sandbox naming helpers", () => {
  it("uses Hermes-oriented sandbox defaults when NemoHermes selects Hermes", () => {
    const previousSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
    try {
      delete process.env.NEMOCLAW_SANDBOX_NAME;
      const hermes = loadAgent("hermes");
      expect(getRequestedSandboxAgentName(null)).toBe("openclaw");
      expect(normalizeSandboxAgentName(null)).toBe("openclaw");
      expect(getDefaultSandboxNameForAgent(null)).toBe("my-assistant");
      expect(getDefaultSandboxNameForAgent(hermes)).toBe("hermes");
      expect(getSandboxPromptDefault(hermes)).toBe("hermes");

      process.env.NEMOCLAW_SANDBOX_NAME = "custom-hermes";
      expect(getSandboxPromptDefault(hermes)).toBe("custom-hermes");
    } finally {
      if (previousSandboxName === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previousSandboxName;
      }
    }
  });

  it("uses NEMOCLAW_SANDBOX_NAME as the interactive prompt default", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "mythos";
      expect(getSandboxPromptDefault(null)).toBe("mythos");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("falls back to agent default when NEMOCLAW_SANDBOX_NAME is invalid", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "123-leading-digit-invalid";
      expect(getSandboxPromptDefault(null)).toBe("my-assistant");

      process.env.NEMOCLAW_SANDBOX_NAME = "bad name";
      expect(getSandboxPromptDefault(null)).toBe("my-assistant");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("exposes the full allowed sandbox name format", () => {
    expect(NAME_ALLOWED_FORMAT).toBe(
      "1-63 characters, lowercase, starts with a letter, letters/numbers/internal hyphens only, ends with letter/number",
    );
  });

  it("explains sandbox name length and allowed format violations", () => {
    expect(getNameValidationGuidance("sandbox name", "a".repeat(64))).toEqual([
      "Sandbox names must be 63 characters or fewer.",
      `Allowed format: ${NAME_ALLOWED_FORMAT}.`,
    ]);
    expect(getNameValidationGuidance("sandbox name", "bad name", { includeAllowedFormat: false }))
      .toEqual(["Sandbox names cannot contain spaces."]);
  });
});
