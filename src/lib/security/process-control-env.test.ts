// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isProcessControlEnvName, PROCESS_CONTROL_ENV_NAMES } from "./process-control-env";

describe("credential-handoff process-control environment policy", () => {
  it("blocks every canonical exact environment name (#5048)", () => {
    for (const name of PROCESS_CONTROL_ENV_NAMES) {
      expect(isProcessControlEnvName(name)).toBe(true);
    }
  });

  it.each([
    "BASH_FUNC_ECHO%%",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_TRACE2_EVENT",
    "NPM_CONFIG_REGISTRY",
    "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
    "PIP_INDEX_URL",
  ])("blocks the process-control rule for %s (#5048)", (name) => {
    expect(isProcessControlEnvName(name)).toBe(true);
  });

  it.each([
    "ALLUSERSPROFILE",
    "APPDATA",
    "CURL_HOME",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "GCONV_PATH",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GLIBC_TUNABLES",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "KUBECONFIG",
    "LOCALAPPDATA",
    "LOCPATH",
    "NETRC",
    "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL",
    "NEMOCLAW_BOOTSTRAP_PAYLOAD",
    "NEMOCLAW_INSTALL_REF",
    "NEMOCLAW_INSTALL_TAG",
    "NEMOCLAW_INSTALLER_STAGED",
    "NEMOCLAW_INSTALLER_URL",
    "NEMOCLAW_OPENSHELL_BIN",
    "NEMOCLAW_OPENSHELL_CHANNEL",
    "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
    "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
    "NEMOCLAW_REPO_ROOT",
    "NEMOCLAW_SOURCE_ROOT",
    "NVM_DIR",
    "OLDPWD",
    "OPENSSL_CONF",
    "OPENSSL_CONF_INCLUDE",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "PROGRAMDATA",
    "PSMODULEPATH",
    "PWD",
    "PYTHONUSERBASE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "VIRTUAL_ENV",
    "XDG_BIN_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_DIRS",
    "XDG_CONFIG_HOME",
    "XDG_DATA_DIRS",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "ZDOTDIR",
  ])("blocks ambient configuration selector %s (#5048)", (name) => {
    expect(isProcessControlEnvName(name)).toBe(true);
  });

  it.each([
    "LANG",
    "PUBLIC_ID",
    "SAFE_SETTING",
  ])("allows unrelated environment name %s (#5048)", (name) => {
    expect(isProcessControlEnvName(name)).toBe(false);
  });
});
