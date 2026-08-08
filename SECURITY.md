<!-- markdownlint-disable MD041 -->
## Security

NVIDIA is dedicated to the security and trust of its software products and services, including all source code repositories managed through our organization.

If you need to report a security issue, use the appropriate contact points outlined below.
**DO NOT report security vulnerabilities through public GitHub issues or pull requests.**
If a potential security issue is inadvertently reported through a public channel, NVIDIA maintainers may limit public discussion and redirect the reporter to the appropriate private disclosure channels.

## How to Report a Vulnerability

Report a potential security vulnerability in NemoClaw or any NVIDIA product through one of the following channels.

### NVIDIA Vulnerability Disclosure Program

Submit a report through the [NVIDIA Vulnerability Disclosure Program](https://www.nvidia.com/en-us/security/report-vulnerability/).
This is the preferred method for reporting security concerns across all NVIDIA products.

### Email

Send an encrypted email to [psirt@nvidia.com](mailto:psirt@nvidia.com).
Use the [NVIDIA public PGP key](https://www.nvidia.com/en-us/security/pgp-key) to encrypt the message.

### GitHub Private Vulnerability Reporting

You can use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configuring-private-vulnerability-reporting-for-a-repository) to submit a report directly on this repository.
Navigate to the **Security** tab and select **Report a vulnerability**.

## What to Include

Provide as much of the following information as possible:

- Product name and version or branch that contains the vulnerability.
- Type of vulnerability (code execution, denial of service, buffer overflow, privilege escalation, etc.).
- Step-by-step instructions to reproduce the vulnerability.
- Proof-of-concept or exploit code.
- Potential impact, including how an attacker could exploit the vulnerability.

Detailed reports help NVIDIA evaluate and address issues faster.

## What to Expect

NVIDIA's Product Security Incident Response Team (PSIRT) triages all incoming reports.
After submission:

1. NVIDIA acknowledges receipt and begins analysis.
2. NVIDIA validates the report and determines severity.
3. NVIDIA develops and tests corrective actions.
4. NVIDIA publishes a security bulletin and releases a fix.

Visit the [PSIRT Policies](https://www.nvidia.com/en-us/security/) page for details on timelines and acknowledgement practices.

While NVIDIA does not currently have a public bug bounty program, we do offer acknowledgement when an externally reported security issue is addressed under our coordinated vulnerability disclosure policy.

## NVIDIA Product Security

For security bulletins, PSIRT policies, and all security-related concerns, visit the [NVIDIA Product Security](https://www.nvidia.com/en-us/security/) portal.
Subscribe to notifications on that page to receive alerts when new bulletins are published.

## Threat Models

Component-level threat models for security-critical NemoClaw subsystems are documented here so a reviewer or auditor can understand what each subsystem is designed to prevent, which surfaces it protects, and where its guarantees end.

### Ollama Auth Proxy Loopback Bind Probe (`#6014`)

**Summary.** The Ollama auth proxy is the token-authenticated network gate in front of a locally-running Ollama backend on every topology where `shouldFrontOllamaWithProxy()` returns true (native Linux, macOS, WSL with a native dockerd runtime). Ollama itself has no built-in authentication. The proxy adds a bearer-token check on its own listen port and forwards to Ollama on the backend port.

**Threat.** If the Ollama backend is reachable on any non-loopback interface on the host (e.g. the user set `OLLAMA_HOST=0.0.0.0:11434`, or an operator-supplied systemd unit binds to a public interface), an attacker on the same LAN, a co-tenant on a shared host, or any process that can open a socket on the host can bypass the proxy entirely by connecting directly to `<host-ip>:11434`. The proxy's token check on the listen port is useless in that case because Ollama is answering questions the proxy never sees.

**Guarantee the bind probe adds.** Before the proxy accepts any traffic, it walks `/proc/net/tcp` and `/proc/net/tcp6` (Linux) or falls back to `lsof -sTCP:LISTEN` (macOS and any host without a readable /proc) to enumerate every LISTEN-state socket on the Ollama backend port. If any listener is not loopback, the proxy refuses to start with exit code `EXIT_BACKEND_NOT_LOOPBACK` (2) and writes a structured `backend-not-loopback` reason to its status file so the host CLI renders an actionable remediation. Loopback for this check is the full 127.0.0.0/8 block for IPv4, `::1` for IPv6, and `::ffff:127.0.0.0/8` for IPv4-mapped IPv6, so a legitimate bind to 127.0.0.2 or an IPv4-mapped IPv6 loopback is accepted.

**Where the guarantee ends.**

- **Docker-Desktop topologies (WSL + Windows-host Ollama, WSL + WSL-local Ollama).** These bypass the proxy entirely via `containerCanReachHostLoopback()` and are explicitly out of scope for this issue and probe. Hardening them is tracked separately.
- **Operator override.** `NEMOCLAW_OLLAMA_PROXY_SKIP_BIND_PROBE=1` disables the probe. The operator setting the override MUST accept that the security posture is degraded. The proxy emits an audit warning to stderr every time the override runs so an incident investigator scanning proxy logs sees the skip and the exact env knob that produced it. This is not fail-closed by design; the escape hatch exists for hosts where /proc is unreadable and `lsof` is missing, and for CI environments that intentionally exercise the non-loopback path.
- **Probe unavailable (both `/proc` and `lsof` absent).** The proxy warns and continues rather than fail-closed. Same reasoning as the operator override: on a host where neither probe surface exists, refusing to start would break the headless install contract with no operator recourse. The systemd loopback override (retained by design for this PR) provides defense in depth on Linux.
- **Runtime bind changes.** The probe runs at startup only. A backend that binds loopback at proxy-start time and later rebinds to a public interface is out of scope. Adding a periodic re-probe is a follow-up.
- **Non-Ollama providers.** The probe protects the Ollama backend specifically; it does not cover NIM, vLLM, or other providers.

**Enforced by:** `test/ollama-auth-proxy-bind-probe.test.ts` covers every branch of both the `/proc` and `lsof` classifiers (accepts full 127.0.0.0/8 including IPv4-mapped IPv6, refuses wildcard and LAN-scope, refuses the lsof `*` token) and the `EXIT_BACKEND_NOT_LOOPBACK = 2` contract with the host CLI.

## Documented Risk Acceptances

The following security-relevant defaults are intentional. Each item names the code path that carries the constraint and the compensating controls that make the trade-off acceptable.

### Deep Agents Code proxy env file is world-readable (mode `0444`)

- **Location:** [`agents/langchain-deepagents-code/start.sh`](agents/langchain-deepagents-code/start.sh) (`prepare_runtime_env`)
- **Constraint:** `/tmp/nemoclaw-proxy-env.sh` is sandbox-user-owned convenience state, not an integrity boundary. It is created with mode `0444` so independent login and exec shells can source the same credential-free settings. The Deep Agents Code runtime deliberately runs as the non-root sandbox user, unlike the root-supervised OpenClaw and Hermes startup paths.
- **Compensating controls:**
  1. The file is credential-free by construction. `prepare_runtime_env` writes normalized proxy config and inherited trust-store paths. It does not persist LangSmith tracing, project, or API key variables.
  2. A regression test in [`test/langchain-deepagents-code-image.test.ts`](test/langchain-deepagents-code-image.test.ts) injects token-shaped values through LangSmith tracing and both project variables, scans the emitted env file against canonical token shapes, and fails CI if any secret-shaped value is present.
  3. The root-owned, image-baked proxy host/port files and direct `dcode-launcher.sh` boundary remain the routing source of truth. Focused and live login-shell checks compare the sourced convenience values with that root-owned source; file metadata checks detect accidental drift but do not claim sandbox-owner tamper resistance.
- **When to revisit:** If a future change adds credential-shaped values to the env-file writer, or if the Deep Agents Code runtime moves back to the root-supervised startup model, revisit the mode and the compensating controls together.
