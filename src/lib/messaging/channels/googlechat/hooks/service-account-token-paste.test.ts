// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { serviceAccountJsonError } from "./service-account-token-paste";

describe("Google Chat service-account enrollment", () => {
  it("accepts JSON with the refresh material required by the gateway", () => {
    expect(
      serviceAccountJsonError(
        JSON.stringify({
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "synthetic-test-private-key-material",
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["invalid JSON", "not-json", "could not be parsed"],
    ["an array", "[]", "must be an object"],
    ["a null value", "null", "must be an object"],
    ["missing client_email", JSON.stringify({ private_key: "key" }), "must include"],
    ["missing private_key", JSON.stringify({ client_email: "bot@example" }), "must include"],
    [
      "blank required fields",
      JSON.stringify({ client_email: " ", private_key: "\n" }),
      "must include",
    ],
  ])("rejects %s before saving the secret", (_case, value, message) => {
    expect(serviceAccountJsonError(value)).toContain(message);
  });
});
