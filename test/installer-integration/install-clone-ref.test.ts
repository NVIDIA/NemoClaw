// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";
import { runSupervisedProcess } from "../helpers/supervised-process";
import { testTimeoutOptions } from "../helpers/timeouts";

const CURL_PIPE_INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");

describe("installer git checkout", testTimeoutOptions(15_000), () => {
  it("fetches fully-qualified refs into a detached checkout without group- or other-writable source entries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-ref-"));
    const origin = path.join(tmp, "origin");
    fs.mkdirSync(origin);
    const git = (args: string[], cwd = origin) => spawnSync("git", args, { cwd, encoding: "utf8" });

    try {
      expect(git(["init", "--initial-branch=topic"]).status).toBe(0);
      expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
      expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
      fs.writeFileSync(path.join(origin, "README.md"), "fixture\n");
      expect(git(["add", "README.md"]).status).toBe(0);
      expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]).status).toBe(0);
      const expectedHead = git(["rev-parse", "HEAD"]).stdout.trim();

      const cases = [INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER].flatMap((installer) =>
        ["0022", "0077", "0002"].map((callerUmask) => ({ callerUmask, installer })),
      );
      cases.forEach(({ callerUmask, installer }, index) => {
        const destination = path.join(tmp, `checkout-${index}`);
        const result = spawnSync(
          "bash",
          [
            "-c",
            'umask "$CALLER_UMASK"\nsource "$INSTALLER_UNDER_TEST"\nclone_nemoclaw_ref refs/heads/topic "$DESTINATION"\nprintf "CALLER_UMASK=%s\\n" "$(umask)"',
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CALLER_UMASK: callerUmask,
              DESTINATION: destination,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://github.com/NVIDIA/NemoClaw.git",
              INSTALLER_UNDER_TEST: installer,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(git(["-C", destination, "rev-parse", "HEAD"], tmp).stdout.trim()).toBe(expectedHead);
        expect(git(["-C", destination, "symbolic-ref", "-q", "HEAD"], tmp).status).not.toBe(0);
        expect(result.stdout).toContain(`CALLER_UMASK=${callerUmask}`);
        expect([
          fs.lstatSync(destination).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git")).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git", "HEAD")).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git", "config")).mode & 0o22,
          fs.lstatSync(path.join(destination, ".git", "objects")).mode & 0o22,
          fs.lstatSync(path.join(destination, "README.md")).mode & 0o22,
        ]).toEqual([0, 0, 0, 0, 0, 0]);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checks out a lightweight tag at its commit, not the branch tip (#7474)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-tag-"));
    const origin = path.join(tmp, "origin");
    fs.mkdirSync(origin);
    const git = (args: string[], cwd = origin) => spawnSync("git", args, { cwd, encoding: "utf8" });

    try {
      expect(git(["init", "--initial-branch=main"]).status).toBe(0);
      expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
      expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
      fs.writeFileSync(path.join(origin, "README.md"), "tagged\n");
      expect(git(["add", "README.md"]).status).toBe(0);
      expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "tagged release"]).status).toBe(0);
      const taggedHead = git(["rev-parse", "HEAD"]).stdout.trim();
      expect(git(["-c", "tag.gpgSign=false", "tag", "v9.9.9"]).status).toBe(0);
      fs.writeFileSync(path.join(origin, "README.md"), "post-release\n");
      expect(git(["add", "README.md"]).status).toBe(0);
      expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "post release"]).status).toBe(0);
      expect(git(["rev-parse", "HEAD"]).stdout.trim()).not.toBe(taggedHead);

      [...[INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER].entries()].forEach(([index, installer]) => {
        const destination = path.join(tmp, `checkout-${index}`);
        const result = spawnSync(
          "bash",
          ["-c", 'source "$INSTALLER_UNDER_TEST"\nclone_nemoclaw_ref v9.9.9 "$DESTINATION"'],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DESTINATION: destination,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://github.com/NVIDIA/NemoClaw.git",
              INSTALLER_UNDER_TEST: installer,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(git(["-C", destination, "rev-parse", "HEAD"], tmp).stdout.trim()).toBe(taggedHead);
        expect(git(["-C", destination, "symbolic-ref", "-q", "HEAD"], tmp).status).not.toBe(0);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("installer version stamping", testTimeoutOptions(15_000), () => {
  const extract = (stdout: string) => stdout.match(/START([\s\S]*?)STOP/)?.[1] ?? null;

  it.each([INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER])(
    "stamps a requested version tag and defers mutable refs to describe [case %#] (#7474)",
    (installer) => {
      const stamp = (ref: string) => {
        const result = spawnSync(
          "bash",
          [
            "-c",
            'source "$INSTALLER_UNDER_TEST"\nprintf START\nresolve_stamped_version "$REF"\nprintf STOP',
          ],
          { encoding: "utf8", env: { ...process.env, INSTALLER_UNDER_TEST: installer, REF: ref } },
        );
        expect(result.status, result.stderr).toBe(0);
        return extract(result.stdout);
      };
      expect(stamp("v0.0.93")).toBe("0.0.93");
      expect(stamp("refs/tags/v1.2.3")).toBe("1.2.3");
      expect(stamp("lkg")).toBe("");
      expect(stamp("latest")).toBe("");
      expect(stamp("main")).toBe("");
    },
  );

  it.each([INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER])(
    "reports the stamped .version over a mismatched git describe [case %#] (#7474)",
    (installer) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-version-"));
      const git = (args: string[]) => spawnSync("git", args, { cwd: tmp, encoding: "utf8" });

      try {
        fs.writeFileSync(
          path.join(tmp, "package.json"),
          `${JSON.stringify({ version: "0.0.1" })}\n`,
        );
        expect(git(["init", "--initial-branch=main"]).status).toBe(0);
        expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
        expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
        fs.writeFileSync(path.join(tmp, "README.md"), "release\n");
        expect(git(["add", "."]).status).toBe(0);
        expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "release"]).status).toBe(0);
        expect(
          git(["-c", "tag.gpgSign=false", "tag", "-a", "v0.0.38", "-m", "old release"]).status,
        ).toBe(0);

        const resolve = (installer: string) =>
          spawnSync(
            "bash",
            [
              "-c",
              'source "$INSTALLER_UNDER_TEST"\nprintf START\nresolve_installer_version\nprintf STOP',
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                INSTALLER_UNDER_TEST: installer,
                NEMOCLAW_REPO_ROOT: tmp,
                NEMOCLAW_INSTALL_REF: "",
                NEMOCLAW_INSTALL_TAG: "",
              },
            },
          );

        fs.writeFileSync(path.join(tmp, ".version"), "0.0.93");
        const withStamp = resolve(installer);
        expect(withStamp.status, withStamp.stderr).toBe(0);
        expect(extract(withStamp.stdout)).toBe("0.0.93");

        fs.rmSync(path.join(tmp, ".version"));
        const withoutStamp = resolve(installer);
        expect(withoutStamp.status, withoutStamp.stderr).toBe(0);
        expect(extract(withoutStamp.stdout)).toBe("0.0.38");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

describe("installer git checkout failures", testTimeoutOptions(15_000), () => {
  const REPO_URL = "https://github.com/NVIDIA/NemoClaw.git";
  const delayedConnectionFailure = `fatal: unable to access '${REPO_URL}/': Failed to connect to github.com port 443 after 132418 ms: Couldn't connect to server`;
  // curl 7.81.0 lib/vtls/openssl.c emits this exact timeout diagnostic.
  const tlsConnectionTimeout = `fatal: unable to access '${REPO_URL}/': SSL connection timeout`;

  function standaloneInstaller(installer: string, directory: string) {
    const copy = path.join(directory, "installer-under-test.sh");
    fs.copyFileSync(installer, copy);
    return copy;
  }

  const cloneWithGitConfig = (
    installer: string,
    ref: string,
    destination: string,
    gitConfig: Record<string, string>,
  ) => {
    const entries = Object.entries(gitConfig);
    return spawnSync(
      "bash",
      ["-c", 'source "$INSTALLER_UNDER_TEST"\nclone_nemoclaw_ref "$REF" "$DESTINATION"'],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DESTINATION: destination,
          GIT_CONFIG_COUNT: String(entries.length),
          ...Object.fromEntries(
            entries.flatMap(([key, value], index) => [
              [`GIT_CONFIG_KEY_${index}`, key],
              [`GIT_CONFIG_VALUE_${index}`, value],
            ]),
          ),
          INSTALLER_UNDER_TEST: standaloneInstaller(installer, path.dirname(destination)),
          REF: ref,
        },
      },
    );
  };

  const closedLoopbackPort = () =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });

  it.each([INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER])(
    "reports a missing ref [case %#] (#11515)",
    (installer) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-missing-ref-"));
      const origin = path.join(tmp, "origin");
      fs.mkdirSync(origin);
      const git = (args: string[]) => spawnSync("git", args, { cwd: origin, encoding: "utf8" });

      try {
        expect(git(["init", "--initial-branch=main"]).status).toBe(0);
        expect(git(["config", "user.name", "NemoClaw Test"]).status).toBe(0);
        expect(git(["config", "user.email", "nemoclaw-test@example.invalid"]).status).toBe(0);
        fs.writeFileSync(path.join(origin, "README.md"), "fixture\n");
        expect(git(["add", "README.md"]).status).toBe(0);
        expect(git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]).status).toBe(0);

        const result = cloneWithGitConfig(
          installer,
          "refs/heads/does-not-exist",
          path.join(tmp, "checkout"),
          { [`url.file://${origin}.insteadOf`]: REPO_URL },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `Requested install ref 'refs/heads/does-not-exist' is not available from ${REPO_URL}.`,
        );
        expect(result.stderr.includes("The installed CLI was not changed.")).toBe(
          installer === CURL_PIPE_INSTALLER,
        );
        expect(result.stderr).not.toContain("Could not connect");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER])(
    "reports a refused connection as an unverified lookup instead of a missing ref [case %#] (#11515)",
    async (installer) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-clone-refused-"));
      const closedPort = await closedLoopbackPort();

      try {
        const result = cloneWithGitConfig(installer, "lkg", path.join(tmp, "checkout"), {
          [`url.http://127.0.0.1:${closedPort}/NemoClaw.git.insteadOf`]: REPO_URL,
          "http.proxy": "",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Could not verify install ref 'lkg' from ${REPO_URL}.`);
        expect(result.stderr.includes("The installed CLI was not changed.")).toBe(
          installer === CURL_PIPE_INSTALLER,
        );
        expect(result.stderr).not.toContain("is not available");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each([INSTALLER_PAYLOAD, CURL_PIPE_INSTALLER])(
    "distinguishes definitive timeout diagnostics from elapsed time [case %#] (#11515)",
    (installer) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-classifier-"));
      const isolatedInstaller = standaloneInstaller(installer, root);
      const classify = (gitError: string) => {
        const result = spawnSync(
          "bash",
          ["-c", 'source "$INSTALLER_UNDER_TEST"\nclassify_install_ref_fetch_failure "$GIT_ERROR"'],
          {
            encoding: "utf8",
            env: { ...process.env, GIT_ERROR: gitError, INSTALLER_UNDER_TEST: isolatedInstaller },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      const unableToAccess = `fatal: unable to access '${REPO_URL}/': `;

      try {
        expect(
          classify(
            `${unableToAccess}Failed to connect to github.com port 443 after 3 ms: Couldn't connect to server`,
          ),
        ).toBe("lookup-failed");
        expect(classify(delayedConnectionFailure)).toBe("lookup-failed");
        expect(
          classify(
            `${unableToAccess}Failed to connect to github.com port 443 after 129003 ms: Connection timed out`,
          ),
        ).toBe("connect-timeout");
        expect(
          classify(
            `${unableToAccess}Operation too slow. Less than 1 bytes/sec transferred the last 1 seconds`,
          ),
        ).toBe("connect-timeout");
        expect(classify(`${unableToAccess}Timeout was reached`)).toBe("connect-timeout");
        expect(classify(tlsConnectionTimeout)).toBe("connect-timeout");
        expect(classify("error: RPC failed; curl 28 SSL connection timeout")).toBe(
          "connect-timeout",
        );
        expect(
          classify("error: RPC failed; curl 28 Operation timed out after 1000 milliseconds"),
        ).toBe("connect-timeout");
        expect(
          classify(
            "error: RPC failed; curl 28 Operation too slow. Less than 1 bytes/sec transferred the last 1 seconds",
          ),
        ).toBe("connect-timeout");
        expect(classify("error: RPC failed; curl 56 Recv failure: Connection reset by peer")).toBe(
          "lookup-failed",
        );
        expect(classify("fatal: invalid refspec '+timed out:refs/nemoclaw-install/target'")).toBe(
          "missing-ref",
        );
        expect(
          classify(
            "fatal: invalid refspec '+error: RPC failed; curl 28 Operation timed out:refs/nemoclaw-install/target'",
          ),
        ).toBe("missing-ref");
        expect(
          classify(
            "fatal: invalid refspec '+error: RPC failed; curl 28 SSL connection timeout:refs/nemoclaw-install/target'",
          ),
        ).toBe("missing-ref");
        expect(
          classify(
            "warning: redirecting to another URL\nerror: RPC failed; curl 28 Operation timed out after 1000 milliseconds",
          ),
        ).toBe("connect-timeout");
        expect(
          classify("fatal: unable to access 'https://timeout.example.test/': Connection refused"),
        ).toBe("lookup-failed");
        expect(classify(`${unableToAccess}Could not resolve host: github.com`)).toBe(
          "lookup-failed",
        );
        expect(
          classify("fatal: Authentication failed for 'https://github.com/NVIDIA/NemoClaw.git/'"),
        ).toBe("lookup-failed");
        expect(
          classify("fatal: repository 'https://github.com/NVIDIA/NemoClaw.git/' not found"),
        ).toBe("lookup-failed");
        expect(classify("")).toBe("lookup-failed");
        expect(classify("fatal: couldn't find remote ref refs/heads/does-not-exist")).toBe(
          "missing-ref",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  const installedCliFixture = (root: string) => {
    const bin = path.join(root, "bin");
    const sourceCli = path.join(root, ".nemoclaw", "source", "bin", "nemoclaw");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.dirname(sourceCli), { recursive: true });
    const cli = path.join(bin, "nemoclaw");
    fs.writeFileSync(sourceCli, "#!/usr/bin/env bash\nprintf 'nemoclaw v0.0.118\\n'\n", {
      mode: 0o755,
    });
    fs.symlinkSync(sourceCli, cli);
    return { bin, cli, digest: sha256(cli) };
  };

  const writeGitFetchFixture = (bin: string) =>
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash
case " $* " in
  *" fetch "*)
    case "$FETCH_MODE" in
      stall | cancel-INT | cancel-TERM)
        /bin/sleep 60 &
        child=$!
        trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 143' TERM
        printf '%s\\n%s\\n' "$$" "$child" >"$FETCH_PIDS"
        case "$FETCH_MODE" in
          cancel-*)
            owner="$(ps -o ppid= -p "$PPID" | tr -d '[:space:]')"
            [[ "$owner" =~ ^[0-9]+$ && "$owner" -gt 1 ]] || exit 98
            kill "-\${FETCH_MODE#cancel-}" "$owner"
            ;;
        esac
        wait "$child"
        ;;
      output)
        printf '%0*d' "$GIT_OUTPUT_BYTES" 0 >&2
        exit 128
        ;;
      diagnostic)
        printf '%s\\n' "$GIT_ERROR_FIXTURE" >&2
        exit 128
        ;;
      completed-124) exit 124 ;;
      *) exit 97 ;;
    esac
    ;;
  *) exec /usr/bin/git "$@" ;;
esac
`,
      { mode: 0o755 },
    );

  const unreachableGitHubEnv = (closedPort: number) => ({
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.http://127.0.0.1:${closedPort}/NemoClaw.git.insteadOf`,
    GIT_CONFIG_VALUE_0: REPO_URL,
    GIT_CONFIG_KEY_1: "http.proxy",
    GIT_CONFIG_VALUE_1: "",
  });

  it("leaves the installed CLI untouched when the curl|bash bootstrap cannot reach GitHub (#11515)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-unreachable-"));
    const closedPort = await closedLoopbackPort();

    try {
      const installed = installedCliFixture(root);
      const result = spawnSync("bash", [], {
        cwd: root,
        input: fs.readFileSync(CURL_PIPE_INSTALLER, "utf8"),
        encoding: "utf8",
        env: {
          HOME: root,
          PATH: `${installed.bin}:/usr/bin:/bin`,
          TMPDIR: root,
          ...unreachableGitHubEnv(closedPort),
        },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        `[ERROR] Could not verify install ref 'lkg' from ${REPO_URL}.`,
      );
      expect(result.stderr).toContain("The installed CLI was not changed.");
      expect(sha256(installed.cli)).toBe(installed.digest);
      const version = spawnSync(installed.cli, ["--version"], { encoding: "utf8" });
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe("nemoclaw v0.0.118");
      expect(fs.readdirSync(root)).toEqual([".nemoclaw", "bin"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { caller: "bootstrap", failure: "stall" },
    { caller: "payload", failure: "stall" },
    { caller: "bootstrap", failure: "delayed failure" },
    { caller: "payload", failure: "delayed failure" },
    { caller: "bootstrap", failure: "TLS timeout" },
    { caller: "payload", failure: "TLS timeout" },
    { caller: "bootstrap", failure: "HTTP 403" },
    { caller: "payload", failure: "HTTP 403" },
    { caller: "bootstrap", failure: "HTTP 500" },
    { caller: "payload", failure: "HTTP 500" },
    { caller: "bootstrap", failure: "fetch deadline" },
    { caller: "bootstrap", failure: "SIGINT" },
    { caller: "bootstrap", failure: "SIGTERM" },
    { caller: "bootstrap", failure: "oversized output" },
    { caller: "bootstrap", failure: "at-limit output" },
    { caller: "bootstrap", failure: "completed child status 124" },
  ] as const)(
    "reports $failure through the $caller fetch boundary (#11515)",
    async ({ caller, failure }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-caller-"));
      const installed = installedCliFixture(root);
      const managedSource = path.join(root, ".nemoclaw", "source");
      const marker = path.join(managedSource, "installed-marker");
      fs.mkdirSync(managedSource, { recursive: true });
      fs.writeFileSync(marker, "previous managed source\n");
      const sockets = new Set<net.Socket>();
      const httpStatus = failure.startsWith("HTTP ") ? failure.slice(5) : "";
      const fetchModes: Record<string, string> = {
        "delayed failure": "diagnostic",
        "TLS timeout": "diagnostic",
        "fetch deadline": "stall",
        SIGINT: "cancel-INT",
        SIGTERM: "cancel-TERM",
        "oversized output": "output",
        "at-limit output": "output",
        "completed child status 124": "completed-124",
      };
      const fetchMode = fetchModes[failure] ?? "";
      const stubbedFetch = Boolean(fetchMode);
      const cancelled = failure === "SIGINT" || failure === "SIGTERM";
      const ownedProcesses = failure === "fetch deadline" || cancelled;
      const fetchPids = path.join(root, "fetch.pids");
      const timeoutExpected =
        failure === "stall" || failure === "TLS timeout" || failure === "fetch deadline";
      const bootstrap = standaloneInstaller(CURL_PIPE_INSTALLER, root);
      fs.writeFileSync(
        bootstrap,
        fs
          .readFileSync(bootstrap, "utf8")
          .replace(
            "BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS=30",
            `BOOTSTRAP_LOOKUP_TIMEOUT_SECONDS=${failure === "fetch deadline" ? 1 : 30}`,
          ),
      );
      let acceptedConnections = 0;
      const server = net.createServer((socket) => {
        acceptedConnections++;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.once("data", () => {
          httpStatus &&
            socket.end(
              `HTTP/1.1 ${httpStatus} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
            );
        });
      });
      try {
        const port = await new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
        });
        stubbedFetch && writeGitFetchFixture(installed.bin);
        const script =
          caller === "bootstrap"
            ? 'exec bash < "$BOOTSTRAP"'
            : 'source "$INSTALLER_PAYLOAD" >/dev/null\nclone_nemoclaw_ref lkg "$PAYLOAD_CHECKOUT"';
        const result = await runSupervisedProcess("bash", ["-c", script], {
          cwd: root,
          env: {
            HOME: root,
            PATH: `${installed.bin}:/usr/bin:/bin`,
            TMPDIR: root,
            BOOTSTRAP: bootstrap,
            INSTALLER_PAYLOAD,
            PAYLOAD_CHECKOUT: path.join(root, "payload-checkout"),
            FETCH_MODE: fetchMode,
            FETCH_PIDS: fetchPids,
            GIT_OUTPUT_BYTES: failure === "oversized output" ? "65537" : "65536",
            GIT_ERROR_FIXTURE:
              failure === "TLS timeout" ? tlsConnectionTimeout : delayedConnectionFailure,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "en_US.UTF-8",
            LANGUAGE: "fr",
            ...unreachableGitHubEnv(port),
            GIT_CONFIG_COUNT: "4",
            GIT_CONFIG_KEY_2: "http.lowSpeedLimit",
            GIT_CONFIG_VALUE_2: "1",
            GIT_CONFIG_KEY_3: "http.lowSpeedTime",
            GIT_CONFIG_VALUE_3: "1",
          },
          timeoutMs: 10_000,
          maxOutputBytesPerStream: 128 * 1024,
        });

        expect(result.error).toBeUndefined();
        expect(result.timedOut).toBe(false);
        expect(result.status, result.stderr).toBe(
          failure === "SIGINT" ? 130 : failure === "SIGTERM" ? 143 : 1,
        );
        expect(acceptedConnections > 0).toBe(!stubbedFetch);
        const details: Record<string, string> = {
          stall: "Timed out looking up install ref",
          "delayed failure": "Git reported 132418 ms elapsed before the lookup failed.",
          "TLS timeout": "SSL connection timeout",
          "HTTP 403": "The requested URL returned error: 403",
          "HTTP 500": "The requested URL returned error: 500",
          "fetch deadline": "Check network access to github.com and try again.",
          "oversized output": "Check repository access and the Git diagnostic, then try again.",
          "at-limit output": "0".repeat(65536),
          "completed child status 124":
            "Check repository access and the Git diagnostic, then try again.",
        };
        const checkDiagnostic = {
          cancelled: () => {
            expect(result.stderr).not.toContain("Could not verify install ref");
          },
          failed: () => {
            expect(result.stderr).toContain(
              timeoutExpected
                ? `Timed out looking up install ref 'lkg' at ${REPO_URL}.`
                : `Could not verify install ref 'lkg' from ${REPO_URL}.`,
            );
            expect(result.stderr).toContain(details[failure]);
          },
        };
        checkDiagnostic[cancelled ? "cancelled" : "failed"]();
        expect(result.stderr.includes("Timed out")).toBe(timeoutExpected);
        expect(result.stderr.includes("Could not verify install ref")).toBe(
          !timeoutExpected && !cancelled,
        );
        expect(result.stderr.includes("Couldn't connect to server")).toBe(
          failure === "delayed failure",
        );
        expect(result.stderr).not.toContain("Could not connect");
        expect(result.stderr.includes("The installed CLI was not changed.")).toBe(
          caller === "bootstrap" && !cancelled,
        );
        expect(result.stderr).not.toContain("is not available");
        const ownedPids = fs.existsSync(fetchPids)
          ? fs.readFileSync(fetchPids, "utf8").trim().split("\n")
          : [];
        expect(ownedPids).toHaveLength(ownedProcesses ? 2 : 0);
        expect(ownedPids[0] ? spawnSync("kill", ["-0", ownedPids[0]]).status : -1).not.toBe(0);
        expect(ownedPids[1] ? spawnSync("kill", ["-0", ownedPids[1]]).status : -1).not.toBe(0);
        const checkBootstrap = () => {
          expect(sha256(installed.cli)).toBe(installed.digest);
          expect(spawnSync(installed.cli, ["--version"], { encoding: "utf8" }).stdout).toBe(
            "nemoclaw v0.0.118\n",
          );
          expect(fs.readFileSync(marker, "utf8")).toBe("previous managed source\n");
          expect(fs.readdirSync(root).sort()).toEqual(
            [
              ".nemoclaw",
              "bin",
              "installer-under-test.sh",
              ...(ownedProcesses ? ["fetch.pids"] : []),
            ].sort(),
          );
        };
        const checkPreservation = { bootstrap: checkBootstrap, payload: () => {} };
        checkPreservation[caller]();
        const checkOutput = {
          "oversized output": () => expect(result.stderr).not.toContain("0".repeat(32)),
        };
        (checkOutput[failure as keyof typeof checkOutput] ?? (() => {}))();
      } finally {
        sockets.forEach((socket) => socket.destroy());
        try {
          await (server.listening
            ? new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              )
            : Promise.resolve());
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );
});
