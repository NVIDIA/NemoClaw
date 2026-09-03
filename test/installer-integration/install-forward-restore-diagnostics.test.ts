// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const INSTALLER = path.join(REPOSITORY_ROOT, "scripts", "install.sh");
const SANDBOX = "created-by-onboard";
const PORT = "8642";
const LISTENER_FAILURE = [
  "ssh process started but local forward listener was not reachable",
  `local forward listener did not open on 127.0.0.1:${PORT} within 10000ms`,
  "last probe failed with Connection refused (os error 111)",
];

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function prepareCheckout(prefix: string): { root: string; binDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, ".nemoclaw");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "onboard-session.json"),
    JSON.stringify({ sandboxName: SANDBOX, agent: "hermes" }),
  );
  fs.writeFileSync(
    path.join(stateDir, "sandboxes.json"),
    JSON.stringify({ sandboxes: { [SANDBOX]: { hermesApiPort: Number(PORT) } } }),
  );
  for (const command of ["sleep"]) {
    writeExecutable(path.join(binDir, command), "#!/usr/bin/env bash\nexit 0\n");
  }
  return { root, binDir };
}

function runRestore(root: string, binDir: string, env: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    ["-c", 'source "$INSTALLER" 2>/dev/null; restore_onboard_forward_after_post_checks'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: root,
        INSTALLER,
        PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ...env,
      },
    },
  );
}

function findWatcherScript(root: string): string {
  const [watcherScript] = fs.globSync(".nemoclaw/**/*.forward.pid.js", { cwd: root });
  expect(watcherScript).toBeDefined();
  return path.join(root, watcherScript as string);
}

function runWatcherTick(watcherScript: string, binDir: string, openshell: string): string {
  const log = `${watcherScript}.calls`;
  spawnSync(process.execPath, [watcherScript, openshell, PORT, SANDBOX], {
    encoding: "utf-8",
    env: { ...process.env, OPENSHELL_LOG: log, PATH: `${binDir}:/usr/bin:/bin` },
    killSignal: "SIGKILL",
    timeout: 2_000,
  });
  return fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
}

function watcherScriptForListing(
  prefix: string,
  listing: string,
  listExitStatus = 0,
): {
  binDir: string;
  openshell: string;
  root: string;
  watcherScript: string;
} {
  const { root, binDir } = prepareCheckout(prefix);
  const openshell = path.join(binDir, "openshell");
  writeExecutable(
    openshell,
    `#!/usr/bin/env bash
if [ -n "\${OPENSHELL_LOG:-}" ]; then printf '%s\\n' "$*" >> "$OPENSHELL_LOG"; fi
if [ "$1" = "forward" ] && [ "$2" = "list" ]; then
  echo "SANDBOX BIND PORT PID STATUS"
${listing}
  exit ${String(listExitStatus)}
fi
exit 0
`,
  );
  writeExecutable(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");
  writeExecutable(
    path.join(binDir, "node"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-e" ] && [[ "\${2:-}" == *"const { spawn }"* ]]; then exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );
  const result = runRestore(root, binDir);
  expect(result.status).toBe(1);
  return { binDir, openshell, root, watcherScript: findWatcherScript(root) };
}

describe("Hermes host forward restore diagnostics", () => {
  it("reports why the OpenShell forward start failed (#8884)", () => {
    const { root, binDir } = prepareCheckout("nemohermes-forward-diagnostic-");
    try {
      writeExecutable(
        path.join(binDir, "openshell"),
        `#!/usr/bin/env bash
if [ "$1" = "forward" ] && [ "$2" = "list" ]; then
  echo "SANDBOX BIND PORT PID STATUS"
  exit 0
fi
if [ "$1" = "forward" ] && [ "$2" = "start" ]; then
${LISTENER_FAILURE.map((line) => `  echo ${JSON.stringify(line)} >&2`).join("\n")}
  exit 1
fi
exit 0
`,
      );
      writeExecutable(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");

      const result = runRestore(root, binDir, { NEMOCLAW_SKIP_FORWARD_WATCHER: "1" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`Could not restore Hermes host forward on port ${PORT}.`);
      expect(result.stdout).toContain("OpenShell reported:");
      expect(LISTENER_FAILURE.every((line) => result.stdout.includes(line))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits the `OpenShell reported:` warning when the failed start printed no output (#8884)", () => {
    const { root, binDir } = prepareCheckout("nemohermes-forward-silent-");
    try {
      writeExecutable(path.join(binDir, "openshell"), "#!/usr/bin/env bash\nexit 1\n");
      writeExecutable(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");

      const result = runRestore(root, binDir, { NEMOCLAW_SKIP_FORWARD_WATCHER: "1" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`Could not restore Hermes host forward on port ${PORT}.`);
      expect(result.stdout).not.toContain("OpenShell reported:");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts a credential from an OpenShell forward-start diagnostic (#8884)", () => {
    const { root, binDir } = prepareCheckout("nemohermes-forward-secret-diagnostic-");
    const token = "nvapi-forward-start-secret-1234567890";
    try {
      writeExecutable(
        path.join(binDir, "openshell"),
        `#!/usr/bin/env bash
if [ "$1" = "forward" ] && [ "$2" = "start" ]; then
  echo "listener rejected token ${token}" >&2
  exit 1
fi
exit 0
`,
      );
      writeExecutable(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");

      const result = runRestore(root, binDir, { NEMOCLAW_SKIP_FORWARD_WATCHER: "1" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("OpenShell reported: listener rejected token <REDACTED>");
      expect(result.stdout).not.toContain(token);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes terminal controls from an OpenShell forward-start diagnostic (#8884)", () => {
    const { root, binDir } = prepareCheckout("nemohermes-forward-control-diagnostic-");
    try {
      writeExecutable(
        path.join(binDir, "openshell"),
        `#!/usr/bin/env bash
if [ "$1" = "forward" ] && [ "$2" = "start" ]; then
  printf '\\033]0;changed title\\033\\listener \\235changed C1 title\\234rejected \\23331mdiagnostic\\2330m\\n' >&2
  exit 1
fi
exit 0
`,
      );
      writeExecutable(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");

      const result = runRestore(root, binDir, { NEMOCLAW_SKIP_FORWARD_WATCHER: "1" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("OpenShell reported: listener rejected diagnostic");
      expect(result.stdout).not.toContain("\u001b");
      expect(result.stdout).not.toContain("\u0007");
      expect(result.stdout).not.toContain("\u009b");
      expect(result.stdout).not.toContain("\u009d");
      expect(result.stdout).not.toContain("changed title");
      expect(result.stdout).not.toContain("changed C1 title");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts the complete diagnostic when the compiled redactor is unavailable (#8884)", () => {
    const { root, binDir } = prepareCheckout("nemohermes-forward-redactor-fallback-");
    const token = "nvapi-forward-fallback-secret-1234567890";
    try {
      writeExecutable(
        path.join(binDir, "openshell"),
        `#!/usr/bin/env bash
if [ "$1" = "forward" ] && [ "$2" = "start" ]; then
  echo "listener rejected token ${token}" >&2
  exit 1
fi
exit 0
`,
      );
      writeExecutable(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");

      const result = runRestore(root, binDir, {
        NEMOCLAW_REPO_ROOT: root,
        NEMOCLAW_SKIP_FORWARD_WATCHER: "1",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("OpenShell reported: <REDACTED>");
      expect(result.stdout).not.toContain(token);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds a long OpenShell forward-start diagnostic (#8884)", () => {
    const { root, binDir } = prepareCheckout("nemohermes-forward-long-diagnostic-");
    const diagnostic = `listener failure: ${"a".repeat(320)} excluded suffix`;
    try {
      writeExecutable(
        path.join(binDir, "openshell"),
        `#!/usr/bin/env bash
if [ "$1" = "forward" ] && [ "$2" = "start" ]; then
  echo ${JSON.stringify(diagnostic)} >&2
  exit 1
fi
exit 0
`,
      );
      writeExecutable(path.join(binDir, "curl"), "#!/usr/bin/env bash\nexit 7\n");

      const result = runRestore(root, binDir, { NEMOCLAW_SKIP_FORWARD_WATCHER: "1" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        `OpenShell reported: ${diagnostic.slice(0, 300)} [truncated]`,
      );
      expect(result.stdout).not.toContain("excluded suffix");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Hermes host forward watcher", { timeout: 10_000 }, () => {
  it.each(["running", "active"])(
    "does not replace a forward that OpenShell lists as %s when the health check fails (#8884)",
    (status) => {
      const { root, binDir, openshell, watcherScript } = watcherScriptForListing(
        `nemohermes-watcher-${status}-`,
        `  echo "${SANDBOX} 127.0.0.1 ${PORT} 123 ${status}"`,
      );
      try {
        const calls = runWatcherTick(watcherScript, binDir, openshell);

        expect(calls).toContain("forward list");
        expect(calls).not.toContain(`forward stop ${PORT} ${SANDBOX}`);
        expect(calls).not.toContain(`forward start --background ${PORT} ${SANDBOX}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["running", "active"])(
    "does not replace a forward that OpenShell colorizes as %s (#8884)",
    (status) => {
      const { root, binDir, openshell, watcherScript } = watcherScriptForListing(
        `nemohermes-watcher-color-${status}-`,
        `  printf '${SANDBOX} 127.0.0.1 ${PORT} 123 \\033[32m${status}\\033[0m\\n'`,
      );
      try {
        const calls = runWatcherTick(watcherScript, binDir, openshell);

        expect(calls).toContain("forward list");
        expect(calls).not.toContain(`forward stop ${PORT} ${SANDBOX}`);
        expect(calls).not.toContain(`forward start --background ${PORT} ${SANDBOX}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not change a forward when OpenShell cannot list forwards (#8884)", () => {
    const { root, binDir, openshell, watcherScript } = watcherScriptForListing(
      "nemohermes-watcher-unreadable-",
      "  :",
      1,
    );
    try {
      const calls = runWatcherTick(watcherScript, binDir, openshell);

      expect(calls).toContain("forward list");
      expect(calls).not.toContain(`forward stop ${PORT} ${SANDBOX}`);
      expect(calls).not.toContain(`forward start --background ${PORT} ${SANDBOX}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replace a forward with an unrecognized OpenShell status (#8884)", () => {
    const { root, binDir, openshell, watcherScript } = watcherScriptForListing(
      "nemohermes-watcher-pending-",
      `  echo "${SANDBOX} 127.0.0.1 ${PORT} 123 pending"`,
    );
    try {
      const calls = runWatcherTick(watcherScript, binDir, openshell);

      expect(calls).toContain("forward list");
      expect(calls).not.toContain(`forward stop ${PORT} ${SANDBOX}`);
      expect(calls).not.toContain(`forward start --background ${PORT} ${SANDBOX}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not run forward stop before starting a forward that OpenShell does not list (#8884)", () => {
    const { root, binDir, openshell, watcherScript } = watcherScriptForListing(
      "nemohermes-watcher-absent-",
      "  :",
    );
    try {
      const calls = runWatcherTick(watcherScript, binDir, openshell);

      expect(calls).toContain(`forward start --background ${PORT} ${SANDBOX}`);
      expect(calls).not.toContain(`forward stop ${PORT} ${SANDBOX}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restarts a forward OpenShell reports as dead (#8884)", () => {
    const { root, binDir, openshell, watcherScript } = watcherScriptForListing(
      "nemohermes-watcher-dead-",
      `  echo "${SANDBOX} 127.0.0.1 ${PORT} 123 dead"`,
    );
    try {
      const calls = runWatcherTick(watcherScript, binDir, openshell);

      expect(calls).toContain(`forward stop ${PORT} ${SANDBOX}`);
      expect(calls).toContain(`forward start --background ${PORT} ${SANDBOX}`);
      expect(calls.indexOf("forward stop")).toBeLessThan(calls.indexOf("forward start"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
