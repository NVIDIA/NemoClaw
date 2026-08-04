// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  findDockerfileRunCommands,
  requireSingleDockerfileRunCommand,
} from "./helpers/dockerfile-run-commands";

const command = "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts";

describe("Dockerfile RUN command discovery", () => {
  it("ignores command text in comments, strings, and non-RUN instructions", () => {
    const source = [
      `# ${command}`,
      `LABEL remediation=\"${command}\"`,
      `RUN printf '%s\\n' '${command}'`,
      `RUN printf '%s\\n' complete # ${command}`,
      "",
    ].join("\n");

    expect(findDockerfileRunCommands(source, command)).toEqual([]);
    expect(() => requireSingleDockerfileRunCommand(source, command)).toThrow(
      "Expected one executing RUN command",
    );
  });

  it("finds a command after a guard in one complete multiline RUN instruction", () => {
    const continuation = "\\";
    const source = [
      `RUN if [ -f /corporate-ca.pem ]; then ${continuation}`,
      `      export CURL_CA_BUNDLE=/corporate-ca.pem; ${continuation}`,
      `    fi; ${continuation}`,
      `    ${command} ${continuation}`,
      "      --npm-root /usr/local/lib/node_modules/npm",
      "ENV NEXT=instruction",
      "",
    ].join("\n");

    const match = requireSingleDockerfileRunCommand(source, command);

    expect(match.commandStart).toBe(source.indexOf(command));
    expect(match.instruction.text).toContain("export CURL_CA_BUNDLE=/corporate-ca.pem");
    expect(match.instruction.text).toContain("--npm-root /usr/local/lib/node_modules/npm");
    expect(match.instruction.text).not.toContain("ENV NEXT=instruction");
  });

  it("reports an extra unguarded command instead of selecting one occurrence", () => {
    const source = [`RUN if true; then ${command}; fi`, `RUN ${command}`, ""].join("\n");

    expect(findDockerfileRunCommands(source, command)).toHaveLength(2);
    expect(() => requireSingleDockerfileRunCommand(source, command)).toThrow("found 2");
  });
});
