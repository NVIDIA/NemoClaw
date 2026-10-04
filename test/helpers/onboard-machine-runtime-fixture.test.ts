// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { cloneSession, createSession } from "./onboard-machine-runtime-fixture";

describe("cloneSession", () => {
  it("isolates invalid session state when normalization rejects the copy", () => {
    const session = createSession();
    session.version = 0;

    const copy = cloneSession(session);

    expect(copy).not.toBe(session);
    expect(copy.steps).not.toBe(session.steps);

    copy.status = "failed";
    copy.steps.preflight.status = "failed";

    expect(session.status).toBe("in_progress");
    expect(session.steps.preflight.status).toBe("pending");
  });
});
