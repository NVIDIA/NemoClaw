// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "../helpers/owned-test-resources";
import { createDoctorTestSetup, writeDoctorSandboxRegistry } from "./helpers";

describe("Sandbox doctor gateway recovery", () => {
  test.for(["openclaw", "hermes"])(
    "plain doctor recovers the registered gateway before probing the %s sandbox",
    (agent, { resources }) => {
      const setup = createDoctorTestSetup(resources, "nemoclaw-doctor-recovery-", [
        'case "$*" in',
        '  "status")',
        '    gateway=other; if [ -f "$marker_file.selected" ]; then gateway=nemoclaw-8090; fi',
        '    printf "Gateway: %s\\nStatus: Connected\\n" "$gateway"; exit 0 ;;',
        '  "gateway info -g nemoclaw-8090") printf "Gateway: nemoclaw-8090\\n"; exit 0 ;;',
        '  "gateway select nemoclaw-8090") touch "$marker_file.selected"; exit 0 ;;',
        '  "sandbox list -g nemoclaw-8090") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
        '  "inference get -g nemoclaw-8090") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        '  "gateway start"*) echo "unrecognized subcommand" >&2; exit 2 ;;',
        "esac",
      ]);
      writeDoctorSandboxRegistry(setup.home, "alpha", {
        agent,
        gatewayName: "nemoclaw-8090",
        gatewayPort: 8090,
      });
      fs.writeFileSync(path.join(setup.localBin, "curl"), '#!/usr/bin/env bash\necho "{}"\n', {
        mode: 0o755,
      });

      const observed = setup.runDoctor("alpha doctor --json");
      expect(observed.code).toBe(1);
      expect(setup.readCalls()).not.toContain("gateway select nemoclaw-8090");

      const recovered = setup.runDoctor("alpha doctor");
      expect(recovered.code, recovered.out).toBe(0);
      const calls = setup.readCalls();
      const recoveryIndex = calls.indexOf("gateway select nemoclaw-8090");
      expect(recoveryIndex).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("sandbox list -g nemoclaw-8090")).toBeGreaterThan(recoveryIndex);
      expect(calls.some((call) => call.startsWith("gateway start"))).toBe(false);
    },
  );
});
