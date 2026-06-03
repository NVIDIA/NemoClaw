// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bridge + DNS preflight gate, extracted from `onboard.ts` so it can be
 * reused as a `--resume` backstop without growing the top-level file
 * past the `onboard-entrypoint-budget` CI ceiling.
 *
 * - `assertDockerBridgeAndContainerDnsHealthy(host)` runs the bridge
 *   container start probe (#3508 Jetson veth) and the DNS-from-inside-
 *   container probe (#3630), and exits with platform-aware remediation
 *   on the fatal reasons described in `[[isFatalContainerDnsProbeFailure]]`.
 */

import { cliDisplayName, cliName } from "./branding";

interface DaemonJsonDnsPatchOpts {
  /** daemon.json path to merge into (e.g. /etc/docker/daemon.json). */
  daemonJsonPath: string;
  /** Containing directory; printed `mkdir -p` ensures it exists. */
  configDir: string;
  /** DNS value to add (concrete IP or a `<placeholder>`). */
  dnsValue: string;
  /** Prepend `sudo` to the printed commands (Linux daemon.json). */
  sudo: boolean;
  /** Suggested jq install command shown when jq is missing. */
  installJqHint: string;
  /** Leading whitespace for the printed lines. */
  indent: string;
}

/**
 * Print a copy-pastable shell snippet that adds a `dns` key to the
 * given daemon.json safely. The snippet:
 *  - creates the containing directory,
 *  - backs up the existing daemon.json,
 *  - requires `jq` (prints an install hint and aborts if missing — no
 *    bare-echo fallback that would clobber an existing daemon.json),
 *  - merges into an existing JSON object via `jq '. + {...}'`,
 *  - creates a new JSON object via `jq -n {...}` when daemon.json is
 *    absent,
 *  - refuses to write if the existing file is not parseable, asking
 *    the user to fix it manually first.
 *
 * The snippet is printed verbatim; nothing here executes it.
 */
function printDaemonJsonDnsPatch(opts: DaemonJsonDnsPatchOpts): void {
  const { daemonJsonPath, configDir, dnsValue, sudo, installJqHint, indent } = opts;
  const sudoPrefix = sudo ? "sudo " : "";
  const dnsJsonLiteral = `{"dns":["${dnsValue}"]}`;
  console.error(`${indent}${sudoPrefix}mkdir -p ${configDir}`);
  console.error(
    `${indent}${sudoPrefix}cp ${daemonJsonPath} ${daemonJsonPath}.bak-$(date +%s) 2>/dev/null || true`,
  );
  // One copy-pastable `sh -c` block so the user runs it as a single
  // unit. Single-quoted shell body uses '"'"' to embed double quotes
  // for jq while keeping the JS template literal readable.
  const shBody = [
    `if ! command -v jq >/dev/null 2>&1; then`,
    `  echo "jq is required to safely merge ${daemonJsonPath}. Install jq (${installJqHint}) and re-run," >&2;`,
    `  echo "or edit ${daemonJsonPath} manually to add: ${dnsJsonLiteral}" >&2;`,
    `  exit 1;`,
    `fi;`,
    `TMP=$(mktemp);`,
    `if [ -f ${daemonJsonPath} ]; then`,
    `  if ! jq '. + ${dnsJsonLiteral}' ${daemonJsonPath} > "$TMP" 2>/dev/null; then`,
    `    echo "${daemonJsonPath} is not valid JSON; fix it manually first" >&2;`,
    `    rm -f "$TMP";`,
    `    exit 1;`,
    `  fi;`,
    `else`,
    `  jq -n '${dnsJsonLiteral}' > "$TMP";`,
    `fi;`,
    `mv "$TMP" ${daemonJsonPath};`,
  ].join(" ");
  console.error(`${indent}${sudoPrefix}sh -c '${shBody.replace(/'/g, "'\"'\"'")}'`);
}
import {
  BUSYBOX_PROBE_IMAGE,
  DOCKER_DESKTOP_WSL_INTEGRATION_HINT,
  type DockerBridgeContainerStartProbeResult,
  getDockerBridgeGatewayIp,
  type HostAssessment,
  isFatalContainerDnsProbeFailure,
  probeContainerDns,
  probeDockerBridgeContainerStart,
} from "./preflight";

type Host = HostAssessment;

export function printDockerBridgeContainerStartFailure(
  result: DockerBridgeContainerStartProbeResult,
  host?: Pick<Host, "isWsl">,
): void {
  console.error("  ✗ Docker could not start a bridge-network test container.");
  if (result.details) {
    for (const line of String(result.details).split("\n").slice(-4)) {
      if (line.trim()) console.error(`    ${line.trim()}`);
    }
  }
  console.error("");
  if (result.reason === "veth_unsupported") {
    console.error(
      "  Docker reported that creating the container veth pair is not supported.",
    );
    console.error(
      "  This matches the Jetson kernel/Docker bridge failure seen before long sandbox builds.",
    );
    console.error(
      `  Update the Jetson Linux kernel/Docker bridge networking support, or run ${cliDisplayName()} on`,
    );
    console.error("  a host whose Docker bridge networking can create veth interfaces.");
  } else if (result.reason === "timeout" || result.reason === "killed") {
    console.error("  Docker did not complete a minimal bridge container start probe in time.");
    console.error("  Restart Docker and check for stuck container/network operations before retrying.");
  } else if (result.reason === "docker_daemon_unreachable") {
    console.error("  The Docker CLI cannot reach the Docker daemon (dockerd is down or wedged).");
    if (host?.isWsl) {
      console.error(`  ${DOCKER_DESKTOP_WSL_INTEGRATION_HINT}`);
    }
    console.error(
      "  Restart the Docker daemon (`sudo systemctl restart docker`, or restart Docker Desktop/Colima)",
    );
    console.error(`  and re-run \`${cliName()} onboard\`.`);
  } else if (result.reason === "image_pull_failed") {
    console.error("  Docker could not pull the busybox test image needed for the preflight probe.");
    console.error("  Ensure the Docker daemon can reach its registry, then retry onboarding.");
  } else {
    console.error("  Docker returned an unexpected failure for a minimal bridge container.");
    console.error("  Restart Docker and retry onboarding after verifying bridge networking.");
  }
  console.error("");
  console.error(`  Verify outside ${cliDisplayName()}:`);
  // Reuse the same pinned BusyBox digest as the automated probe so the
  // command the user copies matches what NemoClaw actually runs.
  console.error(`    docker run --rm --network bridge ${BUSYBOX_PROBE_IMAGE} true`);
}

/**
 * Bridge + DNS preflight checks. Call from both `preflight()` and the
 * `--resume` branch. The cached preflight step doesn't capture host
 * Docker/DNS state, and the original attempt that wrote the cache may
 * have aborted later at sandbox build with exactly the #3508/#3630
 * failure modes. Resuming without re-checking would walk into the same
 * wall (mirroring the [[assertCdiNvidiaGpuSpecPresent]] resume backstop
 * pattern at #3152).
 */
export function assertDockerBridgeAndContainerDnsHealthy(host: Host): void {
  // A minimal bridge-backed container start catches Docker/kernel failures
  // (notably Jetson veth "operation not supported") before longer gateway or
  // sandbox build work starts. Only veth/timeout/killed/daemon-unreachable
  // reasons are definitively a bridge problem; image_pull_failed (e.g. Hub
  // rate limit, proxy outage, registry DNS — handled in the DNS probe below)
  // and bare `error` (e.g. a daemon that disabled the default bridge but
  // uses a managed one) stay inconclusive.
  const bridgeStart = probeDockerBridgeContainerStart();
  if (bridgeStart.ok) {
    console.log("  ✓ Docker can start bridge containers");
  } else if (
    bridgeStart.reason === "veth_unsupported" ||
    bridgeStart.reason === "timeout" ||
    bridgeStart.reason === "killed" ||
    bridgeStart.reason === "docker_daemon_unreachable"
  ) {
    printDockerBridgeContainerStartFailure(bridgeStart, host);
    process.exit(1);
  } else {
    console.warn(
      `  ⚠ Bridge container start probe inconclusive (reason: ${bridgeStart.reason ?? "unknown"}).`,
    );
    if (bridgeStart.details) {
      for (const line of String(bridgeStart.details).split("\n").slice(-3)) {
        if (line.trim()) console.warn(`    ${line.trim()}`);
      }
    }
    console.warn("    Continuing to DNS probe for more specific diagnosis.");
  }

  // DNS resolution from inside containers (#2101). A corp firewall that
  // blocks outbound UDP:53 to public resolvers leaves the sandbox build
  // unable to resolve registry.npmjs.org; npm then retries for ~15 min and
  // prints the cryptic `Exit handler never called`.
  const dns = probeContainerDns();
  const dnsIsFatal = isFatalContainerDnsProbeFailure(dns);

  if (dns.ok) {
    console.log("  ✓ Container DNS resolution works");
    return;
  }
  if (!dnsIsFatal) {
    if (dns.reason === "image_pull_failed") {
      console.warn(
        "  ⚠ Container DNS probe inconclusive: docker couldn't pull the busybox test image.",
      );
      console.warn("    This usually means the docker daemon itself can't reach Docker Hub,");
      console.warn(
        "    but doesn't prove container DNS is broken — the sandbox build may still succeed.",
      );
    } else {
      console.warn(`  ⚠ Container DNS probe inconclusive (reason: ${dns.reason ?? "unknown"}).`);
    }
    if (dns.details) {
      for (const line of String(dns.details).split("\n").slice(-3)) {
        if (line.trim()) console.warn(`    ${line.trim()}`);
      }
    }
    console.warn("    Proceeding. If the sandbox build later hangs at `npm ci`, see issue #2101.");
    return;
  }

  if (dns.reason === "veth_unsupported") {
    printDockerBridgeContainerStartFailure(
      {
        ok: false,
        reason: "veth_unsupported",
        details: dns.details,
        timedOut: dns.timedOut,
        exitCode: dns.exitCode,
        signal: dns.signal,
      },
      host,
    );
    process.exit(1);
  }
  if (dns.reason === "docker_daemon_unreachable") {
    printDockerBridgeContainerStartFailure(
      {
        ok: false,
        reason: "docker_daemon_unreachable",
        details: dns.details,
        timedOut: dns.timedOut,
        exitCode: dns.exitCode,
        signal: dns.signal,
      },
      host,
    );
    process.exit(1);
  }
  if (dns.reason === "timeout" || dns.reason === "killed") {
    console.error("  ✗ Container DNS probe did not complete.");
  } else if (dns.reason === "image_pull_failed") {
    console.error("  ✗ Docker could not resolve or pull the DNS probe image.");
  } else {
    console.error("  ✗ DNS resolution from inside a docker container failed.");
  }
  if (dns.details) {
    for (const line of String(dns.details).split("\n").slice(-4)) {
      if (line.trim()) console.error(`    ${line.trim()}`);
    }
  }
  console.error("");
  printContainerDnsRemediation(host);
  process.exit(1);
}

export function printContainerDnsRemediation(host: Host): void {
  console.error("  The sandbox build runs `npm ci` inside a container and needs to resolve");
  console.error("  registry.npmjs.org. On networks that block outbound UDP:53 to public DNS");
  console.error("  (common in corporate environments that force DNS-over-TLS on the host),");
  console.error("  the build appears to hang for ~15 minutes and then prints the cryptic");
  console.error("  `npm error Exit handler never called`. See issue #2101.");
  console.error("");
  console.error("  Fix options:");
  console.error("");

  // Platform-aware remediation hints. The systemd-resolved fix is
  // Linux-specific; macOS / Windows / WSL-backed-by-Docker-Desktop
  // hosts configure DNS through Docker Desktop's GUI or a
  // platform-specific daemon.json path, so we avoid printing shell
  // commands that would mislead those users.
  const isLinuxWithSystemd =
    host.platform === "linux" && !host.isWsl && host.systemctlAvailable;

  const printLinuxFix = (bridgeIp: string, note: string | null) => {
    if (note) console.error(note);
    console.error("       sudo mkdir -p /etc/systemd/resolved.conf.d/");
    console.error(
      `       printf '[Resolve]\\nDNSStubListenerExtra=${bridgeIp}\\n' | sudo tee /etc/systemd/resolved.conf.d/docker-bridge.conf`,
    );
    console.error("       sudo systemctl restart systemd-resolved");
    console.error("");
    console.error(
      "     Then merge the dns key into /etc/docker/daemon.json (jq required for safe merge; no bare-echo fallback so an existing file is not clobbered):",
    );
    printDaemonJsonDnsPatch({
      daemonJsonPath: "/etc/docker/daemon.json",
      configDir: "/etc/docker",
      dnsValue: bridgeIp,
      sudo: true,
      installJqHint: "sudo apt-get install -y jq",
      indent: "       ",
    });
    console.error("       sudo systemctl restart docker");
  };

  if (isLinuxWithSystemd) {
    const detectedBridgeIp = getDockerBridgeGatewayIp();
    const bridgeIp = detectedBridgeIp || "172.17.0.1";
    let bridgeNote: string | null = null;
    if (detectedBridgeIp && detectedBridgeIp !== "172.17.0.1") {
      bridgeNote = `     (detected your docker bridge gateway at ${detectedBridgeIp})`;
    } else if (!detectedBridgeIp) {
      bridgeNote =
        "     (could not auto-detect bridge IP; using docker's default — verify with:\n" +
        "      docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')";
    }
    console.error("  1. Make systemd-resolved reachable from containers (recommended):");
    printLinuxFix(bridgeIp, bridgeNote);
    console.error("");
    console.error("  2. Configure an explicit UDP:53-capable DNS in /etc/docker/daemon.json");
    console.error("     (ask your IT team for an internal DNS server IP).");
  } else if (host.platform === "darwin") {
    if (host.runtime === "colima") {
      console.error("  Configure Colima's DNS (macOS):");
      console.error("       colima stop");
      console.error("       colima start --dns <corp-dns-ip>");
      console.error("     (or edit ~/.colima/default/colima.yaml and `colima restart`)");
    } else if (host.runtime === "docker-desktop" || host.runtime === "docker") {
      console.error("  Configure Docker Desktop's DNS (macOS):");
      console.error("  Merge the dns key into ~/.docker/daemon.json (jq required for safe merge):");
      printDaemonJsonDnsPatch({
        daemonJsonPath: "~/.docker/daemon.json",
        configDir: "~/.docker",
        dnsValue: "<corp-dns-ip>",
        sudo: false,
        installJqHint: "brew install jq",
        indent: "       ",
      });
      console.error("       osascript -e 'quit app \"Docker\"' && sleep 3 && open -a Docker");
      console.error(
        "     (or do the same via the Docker Desktop UI: Settings → Docker Engine)",
      );
    } else {
      console.error("  Configure your container runtime's DNS (macOS):");
      console.error("     - Docker Desktop (jq required for safe daemon.json merge):");
      printDaemonJsonDnsPatch({
        daemonJsonPath: "~/.docker/daemon.json",
        configDir: "~/.docker",
        dnsValue: "<corp-dns-ip>",
        sudo: false,
        installJqHint: "brew install jq",
        indent: "         ",
      });
      console.error("         osascript -e 'quit app \"Docker\"' && sleep 3 && open -a Docker");
      console.error("     - Colima:");
      console.error("         colima stop && colima start --dns <corp-dns-ip>");
      console.error("     - Rancher Desktop / Podman: edit the runtime's DNS config");
      console.error("       and restart it.");
    }
    console.error("     Ask your IT team for an internal DNS server IP that accepts UDP:53.");
  } else if (host.platform === "win32" || host.isWsl) {
    console.error("  1. Configure Docker Desktop's DNS (Windows / WSL via Docker Desktop):");
    console.error(
      "       Docker Desktop for Windows → Settings → Docker Engine — edit the JSON to add:",
    );
    console.error('         { "dns": ["<corp-dns-ip>"] }');
    console.error("       Then click Apply & Restart.");
    console.error("");
    console.error(
      "  2. If you run docker natively inside WSL (not Docker Desktop), apply the Linux fix:",
    );
    const wslBridgeIp = getDockerBridgeGatewayIp();
    let wslBridgeNote: string | null = null;
    if (wslBridgeIp && wslBridgeIp !== "172.17.0.1") {
      wslBridgeNote = `     (detected your docker bridge gateway at ${wslBridgeIp})`;
    } else if (!wslBridgeIp) {
      wslBridgeNote =
        "     (could not auto-detect bridge IP — the snippet below uses docker's default; verify with:\n" +
        "      docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')";
    }
    const wslIp = wslBridgeIp || "172.17.0.1";
    if (host.systemctlAvailable) {
      // Native WSL with systemd enabled (`/etc/wsl.conf [boot]
      // systemd=true`): the same systemd-resolved + docker daemon.json
      // remediation works.
      printLinuxFix(wslIp, wslBridgeNote);
    } else {
      // WSL without systemd — `systemctl` isn't available, so don't
      // print steps that depend on it. Show the daemon.json safe-merge
      // and a non-systemctl restart hint instead.
      if (wslBridgeNote) console.error(wslBridgeNote);
      console.error("     Merge the dns key into /etc/docker/daemon.json (jq required for safe merge):");
      printDaemonJsonDnsPatch({
        daemonJsonPath: "/etc/docker/daemon.json",
        configDir: "/etc/docker",
        dnsValue: wslIp,
        sudo: true,
        installJqHint: "sudo apt-get install -y jq",
        indent: "       ",
      });
      console.error("     Restart the Docker daemon however your WSL distro launches it");
      console.error("     (e.g. `sudo service docker restart`, or stop the dockerd process and rerun it).");
    }
  } else {
    console.error("  Configure your docker daemon to use a DNS server that accepts UDP:53.");
    console.error(
      '  Add { "dns": ["<corp-dns-ip>"] } to your docker daemon.json and restart the daemon.',
    );
    console.error("  Ask your IT team for an internal DNS server IP.");
  }
  console.error("");
  console.error("  Verify the fix worked:");
  console.error(`    docker run --rm ${BUSYBOX_PROBE_IMAGE} nslookup registry.npmjs.org`);
}
