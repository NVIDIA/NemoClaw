// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  dockerfileRunCommandPositions,
  requireSingleReviewedDockerfileRunCommand,
} from "../../helpers/dockerfile-run-commands";

const command = "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts";
const corporateCaPath = "/usr/local/share/nemoclaw/corporate-ca.pem";
const requiredArguments = ["--npm-root", "/usr/local/lib/node_modules/npm"] as const;
const invocation = [command, ...requiredArguments].join(" ");
const splicedCommand = command.replace("strip-types", "strip-\\\ntypes");

describe("Dockerfile RUN command discovery", () => {
  it("finds only executable unquoted npm command words in RUN instructions (#9933)", () => {
    const source = [
      "# npm install",
      'LABEL example="npm install"',
      'RUN echo "npm install"',
      "RUN echo npm install # npm ci",
      "RUN true && \\",
      "    # install from the reviewed lock",
      "    npm --prefix /runtime ci",
      "RUN if true; then npm --prefix=/runtime install; fi",
      "RUN true && NPM_CONFIG_OFFLINE=true OTHER=value npm ci --prefix /runtime",
      "RUN if npm ci --prefix /if; then true; fi",
      "RUN if false; then true; elif npm install --prefix /elif; then true; fi",
      "RUN while npm ci --prefix /while; do true; done",
      "RUN until npm install --prefix /until; do true; done",
      "RUN ( npm ci --prefix /subshell )",
      "RUN { npm install --prefix /group; }",
      "RUN case value in value) npm ci --prefix /case ;; esac",
      "RUN ! npm install --prefix /negated",
      'RUN NPM_CONFIG_CACHE="/tmp/npm cache" npm ci --prefix /quoted-assignment',
      "RUN NPM_CONFIG_CACHE=/tmp/npm\\ cache npm install --prefix /escaped-assignment",
      "",
    ].join("\n");

    expect(dockerfileRunCommandPositions(source, "npm")).toEqual([
      source.indexOf("npm --prefix /runtime"),
      source.indexOf("npm --prefix=/runtime"),
      source.indexOf("npm ci --prefix"),
      source.indexOf("npm ci --prefix /if"),
      source.indexOf("npm install --prefix /elif"),
      source.indexOf("npm ci --prefix /while"),
      source.indexOf("npm install --prefix /until"),
      source.indexOf("npm ci --prefix /subshell"),
      source.indexOf("npm install --prefix /group"),
      source.indexOf("npm ci --prefix /case"),
      source.indexOf("npm install --prefix /negated"),
      source.indexOf("npm ci --prefix /quoted-assignment"),
      source.indexOf("npm install --prefix /escaped-assignment"),
    ]);
  });

  it("ignores npm assignment values, redirection operands, and here-document delimiters (#9933)", () => {
    const source = [
      "RUN VALUE=npm ci",
      "RUN echo ok > npm",
      "RUN cat <<npm",
      "payload",
      "npm",
      "",
    ].join("\n");

    expect(dockerfileRunCommandPositions(source, "npm")).toEqual([]);
  });

  it("ignores command text in comments, strings, and non-RUN instructions", () => {
    const source = [
      `# ${command}`,
      `LABEL remediation=\"${command}\"`,
      `RUN printf '%s\\n' '${command}'`,
      `RUN printf '%s\\n' complete # ${command}`,
      "",
    ].join("\n");

    expect(() =>
      requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments),
    ).toThrow("Expected one reviewed RUN command");
  });

  it("accepts the reviewed command and arguments as a direct RUN instruction", () => {
    const source = `RUN ${invocation}\nENV NEXT=instruction\n`;

    const match = requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments);

    expect(match.commandStart).toBe(source.indexOf(command));
    expect(match.instruction.text).toBe(`RUN ${invocation}\n`);
  });

  it("finds a command after a guard in one complete multiline RUN instruction", () => {
    const continuation = "\\";
    const source = [
      `RUN if [ -f ${corporateCaPath} ]; then ${continuation}`,
      `      export CURL_CA_BUNDLE=${corporateCaPath}; ${continuation}`,
      `      export NODE_EXTRA_CA_CERTS=${corporateCaPath}; ${continuation}`,
      `    fi; ${continuation}`,
      `    ${command} ${continuation}`,
      `      ${requiredArguments.join(" ")}`,
      "ENV NEXT=instruction",
      "",
    ].join("\n");

    const match = requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments);

    expect(match.commandStart).toBe(source.indexOf(command));
    expect(match.instruction.text).toContain(`export CURL_CA_BUNDLE=${corporateCaPath}`);
    expect(match.instruction.text).toContain(`export NODE_EXTRA_CA_CERTS=${corporateCaPath}`);
    expect(match.instruction.text).toContain("--npm-root /usr/local/lib/node_modules/npm");
    expect(match.instruction.text).not.toContain("ENV NEXT=instruction");
  });

  it("reports an extra unguarded command instead of selecting one occurrence", () => {
    const source = [`RUN ${invocation}`, `RUN ${invocation}`, ""].join("\n");

    expect(() =>
      requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments),
    ).toThrow("found 2");
  });

  it.each([
    ["inside a command substitution", `RUN printf '%s\\n' "$(${invocation})"\n`],
    ["inside backticks", `RUN printf '%s\\n' \`${invocation}\`\n`],
    ["after a parameter-length expansion", `RUN : \${#PATH}; ${invocation}\n`],
    ["inside a split command substitution", `RUN printf '%s\\n' "$\\\n(${invocation})"\n`],
    ["after a split parameter-length expansion", `RUN : $\\\r\n{#PATH}; ${invocation}\n`],
    ["with a spliced command token", `RUN ${splicedCommand} ${requiredArguments.join(" ")}\n`],
  ])("rejects an extra invocation %s", (_label, hiddenInvocation) => {
    const source = [`RUN ${invocation}`, hiddenInvocation].join("\n");

    expect(() =>
      requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments),
    ).toThrow("unreviewed RUN instruction");
  });

  it.each([
    ["a short-circuit branch", `RUN false && ${invocation}\n`],
    ["an uncalled function", `RUN patch() { ${invocation}; }; true\n`],
    ["an unreachable conditional branch", `RUN if false; then ${invocation}; fi\n`],
  ])("rejects the reviewed command inside %s", (_label, source) => {
    expect(() =>
      requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments),
    ).toThrow("unreviewed RUN instruction");
  });

  it.each([
    ["before the command", `RUN printf '%s' '${requiredArguments.join(" ")}'; ${command}\n`],
    ["in one quoted value", `RUN ${command} '${requiredArguments.join(" ")}'\n`],
    ["in a comment", `RUN ${command} # ${requiredArguments.join(" ")}\n`],
  ])("rejects required arguments that occur %s", (_label, source) => {
    expect(() =>
      requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments),
    ).toThrow("unreviewed RUN instruction");
  });

  it.each([
    ["between the command and arguments", `RUN ${command}\u00a0${requiredArguments.join(" ")}\n`],
    ["after the arguments", `RUN ${invocation}\u00a0\n`],
  ])("rejects non-shell whitespace %s", (_label, source) => {
    expect(() =>
      requireSingleReviewedDockerfileRunCommand(source, command, requiredArguments),
    ).toThrow("unreviewed RUN instruction");
  });
});
