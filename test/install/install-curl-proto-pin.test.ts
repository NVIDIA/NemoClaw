// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";

describe("installer curl fetch protocol pinning (#9977)", () => {
  const script = fs.readFileSync(INSTALLER_PAYLOAD, "utf-8");

  it("pins the Docker convenience-script fetch to HTTPS", () => {
    expect(script).toContain(
      "curl -fsSL --proto '=https' --proto-redir '=https' https://get.docker.com -o \"$docker_tmp\"",
    );
  });

  it("pins the installer self re-stage fetch to HTTPS", () => {
    expect(script).toContain(
      "curl -fsSL --proto '=https' --proto-redir '=https' \"$_installer_url\" -o \"$_staged\"",
    );
  });
});
