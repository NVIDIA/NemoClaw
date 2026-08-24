// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { restoreEnvBulk } from "../../../test/helpers/env-test-helpers";
import {
  buildScrubbedCurlProbeEnv,
  CREDENTIAL_ENV_EXPLICIT_DENY,
  isCredentialShapedName,
  SUPPORTED_CREDENTIAL_ENV_NAMES,
  scrubCredentialEnv,
  shouldStripCredentialEnv,
} from "./credential-env";

describe("isCredentialShapedName", () => {
  it.each(["KEY", "secret", "TOKEN", "password", "passwd", "auth", "credential"])(
    "matches the exact credential stem %s",
    (name) => {
      expect(isCredentialShapedName(name)).toBe(true);
    },
  );

  it.each(["MY_API_KEY", "provider-secret", "SESSION_TOKEN", "x_auth_y"])(
    "matches the separated credential name %s",
    (name) => {
      expect(isCredentialShapedName(name)).toBe(true);
    },
  );

  it.each([
    "APIKEY",
    "apikey",
    "accesskey",
    "accessKey",
    "secretkey",
    "authtoken",
    "refreshToken",
    "accesstoken",
    "clientsecret",
  ])("matches the compound credential name %s", (name) => {
    expect(isCredentialShapedName(name)).toBe(true);
  });

  it.each([
    "PRIVATE_KEY",
    "privateKey",
    "passcode",
    "personalAccessToken",
    "connection_string",
    "webhookURL",
    "authorization",
    "bearerToken",
    "cookies",
    "PAT",
    "PIN",
    "DSN",
    "connectionstring",
  ])("matches the local credential-capture name %s (#5048)", (name) => {
    expect(isCredentialShapedName(name)).toBe(true);
  });

  it.each(["SPIN", "DISPATCH", "COOKIEJAR", "PRIVATEERING"])(
    "does not overmatch the benign name %s (#5048)",
    (name) => {
      expect(isCredentialShapedName(name)).toBe(false);
    },
  );

  it.each(["PATH", "HOME", "NO_PROXY", "HTTP_PROXY", "LANG", "monkey", "keyboard"])(
    "does not match the benign name %s",
    (name) => {
      expect(isCredentialShapedName(name)).toBe(false);
    },
  );
});

describe("shouldStripCredentialEnv", () => {
  it.each([...SUPPORTED_CREDENTIAL_ENV_NAMES])(
    "strips the supported credential env name %s",
    (name) => {
      expect(shouldStripCredentialEnv(name)).toBe(true);
    },
  );

  it("keeps the legacy explicit-deny export on the shared inventory", () => {
    expect(CREDENTIAL_ENV_EXPLICIT_DENY).toBe(SUPPORTED_CREDENTIAL_ENV_NAMES);
  });

  it("keeps benign vars", () => {
    expect(shouldStripCredentialEnv("PATH")).toBe(false);
    expect(shouldStripCredentialEnv("NO_PROXY")).toBe(false);
  });
});

describe("scrubCredentialEnv", () => {
  it("drops only credential-shaped keys from the supplied env and never re-adds process.env", () => {
    const scrubbed = scrubCredentialEnv({
      PATH: "/usr/bin",
      NO_PROXY: "localhost",
      HTTP_PROXY: "http://proxy.internal:3128",
      NVIDIA_API_KEY: "nvapi-leak",
      MY_SECRET_TOKEN: "sk-leak",
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.NO_PROXY).toBe("localhost");
    expect(scrubbed.HTTP_PROXY).toBe("http://proxy.internal:3128");
    expect(scrubbed.NVIDIA_API_KEY).toBeUndefined();
    expect(scrubbed.MY_SECRET_TOKEN).toBeUndefined();
    expect(Object.keys(scrubbed).sort()).toEqual(["HTTP_PROXY", "NO_PROXY", "PATH"]);
  });
});

describe("buildScrubbedCurlProbeEnv", () => {
  const TOUCHED_ENV = ["NEMOCLAW_TEST_BENIGN", "NEMOCLAW_TEST_API_KEY", "NGC_API_KEY"];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of TOUCHED_ENV) original[name] = process.env[name];
  });

  afterEach(() => {
    restoreEnvBulk(original);
  });

  it("drops credential-shaped process.env vars but keeps benign ones", () => {
    process.env.NEMOCLAW_TEST_BENIGN = "keep-me";
    process.env.NEMOCLAW_TEST_API_KEY = "drop-me";
    const scrubbed = buildScrubbedCurlProbeEnv();
    expect(scrubbed.NEMOCLAW_TEST_BENIGN).toBe("keep-me");
    expect(scrubbed.NEMOCLAW_TEST_API_KEY).toBeUndefined();
  });

  it("also scrubs credential-shaped keys from the extra overlay", () => {
    const scrubbed = buildScrubbedCurlProbeEnv({
      SAFE_OVERRIDE: "ok",
      EXTRA_SECRET: "nope",
    });
    expect(scrubbed.SAFE_OVERRIDE).toBe("ok");
    expect(scrubbed.EXTRA_SECRET).toBeUndefined();
  });

  it("strips explicitly denied provider vars", () => {
    process.env.NGC_API_KEY = "nvapi-should-not-survive";
    const scrubbed = buildScrubbedCurlProbeEnv();
    expect(scrubbed.NGC_API_KEY).toBeUndefined();
  });
});
