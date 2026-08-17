// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  closeServer,
  createUnownedHealthListener,
  listenOn,
  restoreEnv,
  waitForPortFree,
} from "./helpers/hermes-tool-gateway-broker-ownership-fixture";
import { describe, expect, test as it } from "./helpers/owned-test-resources";
import { testTimeout } from "./helpers/timeouts";

const require = createRequire(import.meta.url);
const BROKER_WRAPPER = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "hermes-tool-gateway-broker.ts",
);

const BROKER_TEST_TIMEOUT_MS = testTimeout(45_000);

/** Every reuse input that must still refuse a listener NemoClaw does not own. */
const UNOWNED_LISTENER_CASES = [
  { label: "a matching hash", forceRestart: false, hashMatches: true },
  { label: "a mismatched hash", forceRestart: false, hashMatches: false },
  { label: "a restart request", forceRestart: true, hashMatches: true },
  { label: "a restart request and a mismatched hash", forceRestart: true, hashMatches: false },
];

/** Every reuse input that resolves to an ordinary restart when the port is dead. */
const UNREACHABLE_PORT_CASES = [
  {
    label: "an unowned broker and a matching hash",
    currentBrokerOwned: false,
    forceRestart: false,
    hashMatches: true,
  },
  {
    label: "an unowned broker and a mismatched hash",
    currentBrokerOwned: false,
    forceRestart: false,
    hashMatches: false,
  },
  {
    label: "an unowned broker and a restart request",
    currentBrokerOwned: false,
    forceRestart: true,
    hashMatches: true,
  },
  {
    label: "an unowned broker, a restart request, and a mismatched hash",
    currentBrokerOwned: false,
    forceRestart: true,
    hashMatches: false,
  },
  {
    label: "an owned broker and a matching hash",
    currentBrokerOwned: true,
    forceRestart: false,
    hashMatches: true,
  },
  {
    label: "an owned broker and a mismatched hash",
    currentBrokerOwned: true,
    forceRestart: false,
    hashMatches: false,
  },
  {
    label: "an owned broker and a restart request",
    currentBrokerOwned: true,
    forceRestart: true,
    hashMatches: true,
  },
  {
    label: "an owned broker, a restart request, and a mismatched hash",
    currentBrokerOwned: true,
    forceRestart: true,
    hashMatches: false,
  },
];

function loadBrokerWithHome(home: string) {
  process.env.HOME = home;
  // The module resolves its credential paths at load time, and
  // `brokerStartedThisRun` is module state, so each case needs a fresh copy.
  delete require.cache[require.resolve(BROKER_WRAPPER)];
  return require(BROKER_WRAPPER);
}

describe("Hermes managed-tool broker ownership", () => {
  it("refuses to adopt a healthy listener it does not own", () => {
    const broker = require(BROKER_WRAPPER);

    expect(
      broker.planHermesToolGatewayBrokerReuse({
        brokerHealthy: true,
        currentBrokerOwned: false,
        forceRestart: false,
        hashMatches: true,
      }),
    ).toBe("refuse-unowned-listener");
  });

  // Ownership is the only input that may admit a listener. A mismatched hash or
  // a restart request must not downgrade the refusal into an ordinary "no
  // broker" outcome, because only the refusal names the held port.
  it.each(UNOWNED_LISTENER_CASES)(
    "keeps refusing an unowned listener with $label",
    ({ forceRestart, hashMatches }) => {
      const broker = require(BROKER_WRAPPER);

      expect(
        broker.planHermesToolGatewayBrokerReuse({
          brokerHealthy: true,
          currentBrokerOwned: false,
          forceRestart,
          hashMatches,
        }),
      ).toBe("refuse-unowned-listener");
    },
  );

  it("treats an omitted restart request as no restart", () => {
    const broker = require(BROKER_WRAPPER);

    // `ensureHermesToolGatewayBroker` forwards `options.forceRestart`, which is
    // undefined whenever a caller omits it, so the default is the production
    // path rather than a convenience.
    expect(
      broker.planHermesToolGatewayBrokerReuse({
        brokerHealthy: true,
        currentBrokerOwned: true,
        hashMatches: true,
      }),
    ).toBe("reuse-current");
    expect(
      broker.planHermesToolGatewayBrokerReuse({
        brokerHealthy: true,
        currentBrokerOwned: false,
        hashMatches: true,
      }),
    ).toBe("refuse-unowned-listener");
  });

  it("adopts a healthy listener it owns when the runtime hash still matches", () => {
    const broker = require(BROKER_WRAPPER);

    expect(
      broker.planHermesToolGatewayBrokerReuse({
        brokerHealthy: true,
        currentBrokerOwned: true,
        forceRestart: false,
        hashMatches: true,
      }),
    ).toBe("reuse-current");
  });

  it("declines an owned broker when the runtime hash moved or a restart was requested", () => {
    const broker = require(BROKER_WRAPPER);

    expect(
      broker.planHermesToolGatewayBrokerReuse({
        brokerHealthy: true,
        currentBrokerOwned: true,
        forceRestart: false,
        hashMatches: false,
      }),
    ).toBe("no-usable-broker");
    expect(
      broker.planHermesToolGatewayBrokerReuse({
        brokerHealthy: true,
        currentBrokerOwned: true,
        forceRestart: true,
        hashMatches: true,
      }),
    ).toBe("no-usable-broker");
    expect(
      broker.planHermesToolGatewayBrokerReuse({
        brokerHealthy: true,
        currentBrokerOwned: true,
        forceRestart: true,
        hashMatches: false,
      }),
    ).toBe("no-usable-broker");
  });

  // An unreachable port cannot be refused as unowned; it is the ordinary
  // restart case whether or not a prior broker was ours.
  it.each(UNREACHABLE_PORT_CASES)(
    "reports no usable broker when nothing answers on the port with $label",
    ({ currentBrokerOwned, forceRestart, hashMatches }) => {
      const broker = require(BROKER_WRAPPER);

      expect(
        broker.planHermesToolGatewayBrokerReuse({
          brokerHealthy: false,
          currentBrokerOwned,
          forceRestart,
          hashMatches,
        }),
      ).toBe("no-usable-broker");
    },
  );

  it(
    "reports no broker when a foreign listener answers health after a stale hash is left behind",
    async ({ skip }) => {
      const previousHome = process.env.HOME;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-broker-unowned-"));
      const impostor = createUnownedHealthListener();

      try {
        const staging = loadBrokerWithHome(home);
        const credsDir = path.dirname(staging.HERMES_TOOL_GATEWAY_STATE_DIR);
        const hashPath = path.join(credsDir, "hermes-tool-gateway-broker.hash");
        const pidPath = path.join(credsDir, "hermes-tool-gateway-broker.pid");

        // Let the module write its own runtime hash rather than recomputing it
        // here. A hand-built hash would stop matching the moment the runtime
        // inputs change, and this case would then pass for the wrong reason.
        // The hash is written when the broker is spawned, so it exists whether
        // or not that broker went on to become healthy.
        staging.ensureHermesToolGatewayBroker({ startWithoutCredential: true });
        const runtimeHash = fs.readFileSync(hashPath, "utf8");

        staging.killStaleHermesToolGatewayBroker();
        await waitForPortFree(staging.HERMES_TOOL_GATEWAY_PORT);

        // A broker that crashed leaves its runtime hash behind while the pid
        // goes away. That is the exact state this regression covers.
        fs.writeFileSync(hashPath, runtimeHash, { mode: 0o600 });
        expect(fs.existsSync(pidPath)).toBe(false);

        const settled = loadBrokerWithHome(home);
        await listenOn(impostor, settled.HERMES_TOOL_GATEWAY_PORT);
        // The probe shells out to curl. Where a harness blocks loopback HTTP
        // for subprocesses, no listener can be observed as healthy and this
        // case would assert nothing, so report it as skipped instead of passed.
        skip(
          !settled.isHermesToolGatewayBrokerHealthy(),
          "curl cannot read a loopback response in this environment",
        );

        // Reachability alone must not answer "broker ready".
        expect(settled.ensureHermesToolGatewayBroker({})).toBe(false);
      } finally {
        await closeServer(impostor);
        restoreEnv("HOME", previousHome);
        delete require.cache[require.resolve(BROKER_WRAPPER)];
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    BROKER_TEST_TIMEOUT_MS,
  );
});
