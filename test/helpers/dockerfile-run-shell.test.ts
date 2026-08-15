// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { dockerRunCommandBetween } from "./dockerfile-run-shell";

describe("Dockerfile RUN shell extraction", () => {
  it("removes Docker instruction options before returning the shell command", () => {
    const dockerfile = [
      "# start",
      "RUN --network=default --security=insecure set -eu; \\",
      "    printf 'ready\\n'",
      "# end",
    ].join("\n");

    expect(dockerRunCommandBetween(dockerfile, "# start", "# end")).toBe(
      "set -eu;  printf 'ready\\n'",
    );
  });

  it("ignores Dockerfile comments inside a continued RUN instruction", () => {
    const dockerfile = [
      "# start",
      "RUN --network=default if true; then \\",
      "    # Dockerfile ignores comment-only continuation lines.",
      "    printf 'ready\\n'; \\",
      "fi",
      "# end",
    ].join("\n");

    expect(dockerRunCommandBetween(dockerfile, "# start", "# end")).toBe(
      "if true; then  printf 'ready\\n';  fi",
    );
  });
});
