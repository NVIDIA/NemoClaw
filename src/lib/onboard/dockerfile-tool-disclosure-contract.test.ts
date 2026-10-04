// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchStagedDockerfile } from "./dockerfile-patch";

const tmpRoots: string[] = [];

function dockerfileWith(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tool-disclosure-contract-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Dockerfile tool-disclosure contract", () => {
  it("requires one consumed tool-disclosure ARG for custom image contracts", () => {
    const patchCustom = (source: string) => {
      const dockerfilePath = dockerfileWith(source);
      patchStagedDockerfile(
        dockerfilePath,
        "custom-model",
        "http://127.0.0.1:18789",
        "build-1",
        "nvidia-prod",
        null,
        null,
        null,
        false,
        null,
        [],
        {
          toolDisclosure: "direct",
          requireToolDisclosureContract: true,
        },
      );
      return fs.readFileSync(dockerfilePath, "utf8");
    };

    expect(() => patchCustom("FROM scratch\n")).toThrow(/does not declare ARG/);
    expect(() =>
      patchCustom(
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nARG NEMOCLAW_TOOL_DISCLOSURE=direct\n",
      ),
    ).toThrow(/exactly one/);
    expect(() => patchCustom("ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\n")).toThrow(
      /promote.*final-stage ENV/,
    );
    expect(() =>
      patchCustom(
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\n# ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}\n",
      ),
    ).toThrow(/promote.*final-stage ENV/);
    expect(() =>
      patchCustom(
        "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}\nARG NEMOCLAW_TOOL_DISCLOSURE=progressive\n",
      ),
    ).toThrow(/after its declaration/);
    expect(() =>
      patchCustom(
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}\nENV NEMOCLAW_TOOL_DISCLOSURE=progressive\n",
      ),
    ).toThrow(/no later override/);
    expect(() =>
      patchCustom(
        'ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV FOO="prefix NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE} suffix"\n',
      ),
    ).toThrow(/promote.*final-stage ENV/);
    expect(() =>
      patchCustom(
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=\\$NEMOCLAW_TOOL_DISCLOSURE\n",
      ),
    ).toThrow(/promote.*final-stage ENV/);
    expect(() =>
      patchCustom(
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE='$NEMOCLAW_TOOL_DISCLOSURE'\n",
      ),
    ).toThrow(/promote.*final-stage ENV/);
    expect(() =>
      patchCustom(
        [
          "FROM scratch AS discarded",
          "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
          "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
          "FROM scratch",
        ].join("\n"),
      ),
    ).toThrow(/outside the final stage/);
    expect(
      patchCustom(
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}\n",
      ),
    ).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=direct");
    expect(
      patchCustom(
        "FROM scratch\nARG   NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}\n",
      ),
    ).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=direct");
    expect(
      patchCustom(
        'FROM scratch\nARG NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE="${NEMOCLAW_TOOL_DISCLOSURE}"\n',
      ),
    ).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=direct");
    expect(
      patchCustom(
        "FROM scratch\nARG \\\n  NEMOCLAW_TOOL_DISCLOSURE=progressive\nENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}\n",
      ),
    ).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=direct");
    const patchedMultiStage = patchCustom(
      [
        "FROM scratch AS build",
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
        "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
        "FROM scratch",
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
        "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
      ].join("\n"),
    );
    expect(patchedMultiStage.match(/ARG NEMOCLAW_TOOL_DISCLOSURE=progressive/g)).toHaveLength(1);
    expect(patchedMultiStage.match(/ARG NEMOCLAW_TOOL_DISCLOSURE=direct/g)).toHaveLength(1);
    expect(() =>
      patchCustom(
        [
          "FROM scratch",
          'RUN <<\'FIRST\' <<"SEC""OND"',
          "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
          "FIRST",
          "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
          "SECOND",
        ].join("\n"),
      ),
    ).toThrow(/does not declare ARG/);
    const heredocSource = [
      "FROM scratch",
      'SHELL ["/bin/bash", "-c"]',
      "RUN cat <<<payload",
      "RUN echo '<<EOF'",
      "RUN printf '%s' \"<<TAG\"",
      "RUN <<-'FAKE'",
      "\tFROM fake",
      "\tARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
      "\tENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
      "\tFAKE",
      "ARG   NEMOCLAW_TOOL_DISCLOSURE=progressive",
      "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
    ].join("\n");
    const patchedHeredoc = patchCustom(heredocSource);
    expect(patchedHeredoc).toContain("RUN cat <<<payload");
    expect(patchedHeredoc).toContain("RUN echo '<<EOF'");
    expect(patchedHeredoc).toContain("RUN printf '%s' \"<<TAG\"");
    expect(patchedHeredoc).toContain("\tARG NEMOCLAW_TOOL_DISCLOSURE=progressive");
    expect(patchedHeredoc).toContain("ARG NEMOCLAW_TOOL_DISCLOSURE=direct");
    expect(() => patchCustom("FROM scratch\nRUN <<EOF\nARG ignored=value\n")).toThrow(
      /unterminated heredoc 'EOF'/,
    );
  });
});
