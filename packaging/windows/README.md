<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Windows candidate package

## Agent scope

This Windows candidate includes OpenClaw and Hermes only. Each finished package
contains its build-selected agent; the other remains unavailable in that package.
Standalone Pi, Deep Agents Code, and NemoCUA integrations have been removed.
Their source remains in Git history. Existing state and credential cleanup still
recognize those historical identities; they cannot start a new agent session.
Setup's selectable data-removal choices are OpenClaw and Hermes only. Historical
shortcut cleanup and recognition of retained legacy state remain separate from
those choices; uninstall does not silently delete retired agents' data or keys.
Non-Windows integrations and OpenClaw's internal dependencies are unchanged.
This scope reduction does not establish installed qualification or release approval.

An included OpenClaw or Hermes preview can be configured and launched while its package
status remains `unqualified`. Setup displays the pending-runtime-checks warning
during agent selection and configuration. Missing or invalid availability records
and `not-included` agents remain unavailable. Preview selection does not grant
runtime admission, mark evidence qualified, authorize CI credentials, or satisfy
qualified-publication gates.

Same-repository OpenClaw pull requests publish a downloadable Actions artifact
named `unqualified-openclaw-preview-<commit>-<run>-<attempt>` after the package
build succeeds. It contains the exact setup EXE, build and runtime identities,
and an explicit unqualified-preview label with the EXE hash. The same-run
transfer and exact package inventory are verified before upload. This download
does not wait for installed acceptance, does not use provider credentials, and
is not a GitHub release. Full qualification and qualified publication retain
their separate protected workflow and approval gates.

## Windows Preview and Remaining Qualification

The finished-host build now pins OpenShell
`624f55b3c6affedd4f2757c7eb32132196b4c3e8` from the current `windows` branch
and source-built MXC `7cd00d1ee6af9208322c924ef64e5113f6704639`.
The older `windows-0.0.x-backup` branch is not the build base. Upstream runtime
qualification does not establish installer acceptance. OpenShell also applies
`openshell-native-transport.patch`, bound to its SHA-256 and complete resulting
Git tree in `openshell-native-transport.lock.json`. The build requires a clean
pinned base, verifies the patched tree before and after compilation, and rejects
unexpected staged, unstaged or untracked source. MXC retains its unchanged-source
requirement. Both projects use fresh target directories and record same-run hashes.
The OpenShell inventory includes the CLI, gateway, supervisor, Windows sandbox
executable, and `libz3.dll`. This Windows sandbox executable implements the
OpenShell sandbox protocol; it is not Microsoft's Windows Sandbox backend.

The OpenClaw web worker uses fixed sandbox-local named pipes for its gateway and
inference broker. The OpenShell derivative carries supervisor control over
inherited standard I/O and forwards declared logical ports to those local pipes,
without adding a broad host-loopback grant. The patch includes the dependent
forwarding and lifecycle repairs in the tested source tree. Host admission now
requires both its patch digest and source-tree identity; the old unpatched receipt
is not accepted. Local real-provider, restart and web-worker evidence does not
qualify a newly built installer or establish outer-network-fence enforcement.

The compiled launcher supports the OpenClaw Control UI and Hermes dashboard,
including the prepared Hermes PTY runtime. Installed sessions use authenticated
OpenShell gateways and job-owned supervisor cleanup. The installer may publish
these paths as unqualified previews, as described above.

Functional evidence remains specific to the tested revision and artifact.
A passing preview journey does not establish protected provider qualification,
network-policy enforcement, or release readiness. New runtime changes require
new installed lifecycle evidence; earlier OpenClaw or Hermes results cannot
qualify a replacement package.

The retained launchers provision fresh TLS and JWT keys through a shared gateway
session owner. Its sibling session directory permits access only to the Windows
user and SYSTEM. It contains gateway keys, imported CLI certificates, and supervisor
state; it is outside the workload share and ordinary logs. The bundled UI helper
returns certificate material through a bounded pipe without using certificate stores.
Launchers require HTTPS and mTLS user authentication. Cleanup stops owned processes
before removing the directory. A failed stop retains the private directory and
reports a cleanup failure. Component tests exercise the real UI helper and private
directory controls; they do not establish OpenShell authorization or installed acceptance.

The launchers start the gateway through a native job owner. Windows assigns the
gateway to the job before it runs; its supervisor and executor inherit ownership.
Normal gateway exit or a session-bound stop request terminates the job. Private
state is removed only after the owner reports zero active processes. Killing the
owner closes the job, but without a verified shutdown record the launcher retains
private state and reports cleanup failure. Local process controls cover this
behavior; exact-artifact MXC and real-console validation remain required.

Console launchers now request a sandbox terminal and attach with `sandbox connect`
through the session's authenticated CLI environment. They no longer request legacy
host-console sharing. Success requires matching client and contained-agent exit
statuses. Cleanup stops the private gateway before waiting for the client to drain.
An undrained client reports failure; the native runtime owner retains responsibility
for the complete process tree. Hermes dashboard sessions keep their separate PTY
path. Focused tests cover attachment, exit-status reconciliation, and failure cleanup;
installed interactive acceptance with the selected runtime remains required.

Hermes reuse now pins base artifact `11995339173` from run `38778013068`, built
from `8f54e647a1cda1c3c879ad4e350700a13bb8fc2e`. This base contains the startup
adapter and native dashboard pipe adapter. Reuse relocates generated path metadata without changing
the adapter or claiming a historical upgrade. The wheel, Git, export, and Personal
probe consumers retain the same base identity. Fresh compatibility proof, moved-root
execution, and installed acceptance remain required. The historical replay and
finished-runtime qualification pins have not been promoted to this new base.

The passing Windows-tip cycles allowed host loopback through the host-supervisor
protocol. They did not prove denied host loopback, port-only isolation, an outer
network fence, or live policy revocation. Keep those limitations separate from
functional acceptance. Do not replace denied-network evidence with the passing
preview result. Fresh installed OpenClaw and Hermes acceptance must
use the newly built package and record its actual Windows and runtime identities.

## Existing installer behavior and remaining migration surface

This directory owns the WiX-authored ARM64 MSI and Burn setup executable for
the native Windows candidate. WiX Toolset 5.0.2 and its standard bootstrapper
application extension are pinned in the project files.
The workflow verifies the WiX CLI package against `installer/wix-tool-input.json`
before installation. NuGet restores that tool from the verified local package,
using fresh caches and no additional package source.

The package uses only standard Windows Installer and Burn authoring. It has no
custom actions and does not invoke PowerShell, WSL, Bash, Ubuntu, Docker, or a
Linux virtual machine. The package installs the exact assembled ARM64 NemoClaw
runtime payload under `%ProgramFiles%\NVIDIA\NemoClaw`. That payload contains
the NemoClaw CLI, the selected agent and its required runtime, NVIDIA/OpenShell CLI
and gateway binaries, and only the pinned Microsoft MXC ProcessContainer
executor and host-preparation utility. WSLC, Windows Sandbox, test-proxy,
diagnostic, and learning-mode sidecars from the upstream SDK archive are not
packaged. Windows Installer registers normal Add/Remove Programs metadata and
adds the installed `bin` directory to the machine PATH.

`finished_windows_agent` selects the agent included in each finished installer.
The embedded runtime-availability record marks unselected agents `not-included`,
and setup disables those choices. One package does not qualify all agent variants.

The finished-installer workflow checks out the OpenShell `windows` revision in
`openshell-native-transport.lock.json`, applies its locked compatibility patch, and builds and tests the
ARM64 derivative. It records both executable hashes, the source and patch identities,
and the workflow run. Host preparation rejects mismatched receipts or binaries;
it does not reuse binaries from a previous MSI. The patch and its exact hash are installed with the
product. Packaged Node workloads explicitly set `windows_ui=true` so the
contained Node process can initialize. Other sandboxes retain MXC's disabled-UI
default. The derivative also adds per-sandbox `host_loopback`, `host_console`, and
`personal_network` options. Configured OpenClaw web sessions and the shared
OpenClaw/Hermes console/dashboard path use the supervised profile.
It sets `pc_allow_local_network=false` and omits direct-network
options; these sessions do not select Personal networking or legacy host-console sharing.
This configuration does not establish network-policy enforcement or grant access
to the Windows user-profile filesystem.

Qualification networking is separate. Probes check the installed MXC tier:
AppContainer retains its original network policy; BaseContainer
uses `loopback_ports` for the contained mock model and UI listeners. This emits
MXC 0.8 TCP rules for only those `127.0.0.1` ports, with other egress and host
loopback ingress denied. Unknown or inconsistent probes stop qualification.
Port rules cannot be combined with Personal or legacy host-loopback options.
The driver accepts whole ports from 1 through 65535 through protobuf's numeric
representation; fractions, zero, overflow and nonnumeric values are rejected.
The UI reports failed creation before waiting for relay readiness. It skips
sandbox teardown only after definitive rejection and a confirmed empty registry;
transport failures still require ordinary cleanup and reconciliation.

The tested ARM64 runner selects MXC's AppContainer fallback. The gateway template
retains `pc_least_privilege=false` and `privateNetworkClientServer`. Personal
compatibility probes add `internetClient` for public outbound connections;
configured sessions do not select that profile. The qualification default does
not add that capability. These are
preview compatibility settings across the agent set; they do not establish LPAC
qualification or governed egress-policy parity. The legacy `allowLocalNetwork`
field has version-dependent ingress semantics. Retiring these exceptions needs
agent, broker, negative filesystem, and network evidence on the selected Windows
and MXC builds. Runtime qualification remains tracked in
[#8178](https://github.com/NVIDIA/NemoClaw/issues/8178).

Each run writes a gateway configuration outside the installed payload. It
preserves the installed template's settings and resolves `wxc_exec_path` from
the actual installation directory, including an overridden `INSTALLFOLDER`.
The qualification turn executes OpenClaw in a worker inside that same contained
Node process, avoiding an unsupported nested-process assumption while retaining
MXC filesystem containment. The package does not bypass OpenShell or call MXC
directly from NemoClaw. The pinned OpenShell CLI watch does not return after the
one-shot MXC workload completes, so the qualification command stops that
client-side watcher after receiving the exact workload result and then deletes
the sandbox through OpenShell.

Before install or repair, Burn queries its bundled, hash-pinned MXC executable
with `--probe` and records the selected tier. Finished packages compile the probe
digest into Setup from the admitted same-run MXC build and recheck it before Burn
composition. Missing, ambiguous or substituted probe identities stop the build
or launch; external files and environment variables cannot override the compiled
digest. The legacy preview retains its original 0.8.0 probe pin. BaseContainer skips both
AppContainer host prerequisites without changing root or null-device permissions.
AppContainer+DACL retains system-drive metadata preparation and the pinned MXC
null-device preparation through Burn's elevated engine. Existing permission
conflicts still stop preparation. Failed, unknown or inconsistent probes stop
installation; they do not select a fallback. Uninstall does not require a probe.
The null-device setting resets when Windows reboots. This prerequisite selection
does not establish runtime qualification or change the selected session network profile.

The self-contained ARM64 WPF setup presents one custom-framed window for agent
selection, inference, optional services, installation progress, and completion.
This installer flow does not use HTML, WebView, Edge, or a browser. An explicit
API-key help action can open the service's official page in the user's browser.
The installed launcher's unconfigured web-launch path instead opens browser
onboarding through a local HTTP server. That path saves the agent configuration
before launching the selected agent.
Progress names the current phase and refreshes elapsed time regularly; download
and installer percentages come from actual work, while unknown-duration phases
remain indeterminate.

Setup creates current-user desktop shortcuts for NemoClaw Setup and each configured
agent, using their own icons. The setup shortcut uses the registered cached
installer for maintenance. Uninstall appears only for an installed product and
preserves data by default; explicit per-agent removal checks ownership and active
sessions before deleting state, settings, and scoped keys. Web agents use the
Windows default browser and a native session-control window with explicit Stop.
Closing that control waits for sandbox, gateway, broker, and state cleanup.

The selected agent carries through configuration and launch, and the installed
launcher remembers the last configured agent. The same native window edits
settings later. Agent launch is an explicit completion action.
`agent-support.json` records the packaged
implementations and their preview limitations.

The compiled OpenClaw package retains its published workspace templates under
the canonical package root. Fresh workspace bootstrap needs these files even when
existing-workspace tool checks pass. Resource composition preserves their bytes
and inventory hashes and rejects missing directories or linked input files.

Hermes uses the corrected pywinpty ARM64 wheel, including its matched `conpty.dll`
and `OpenConsole.exe` beside the native Python extension. The Microsoft ConPTY
notice is installed as `hermes/CONPTY-LICENSE.txt`. An early Windows check loads
that exact library and proves input, output, child-observed resize, and cleanup
before the long runtime build; full packaged qualification repeats the check.
This addresses the omitted binaries documented in the
[pywinpty 3.0.5 release](https://github.com/andfoy/pywinpty/releases/tag/v3.0.5).

Provider endpoint, model, Personal profile, and optional-service selections are
nonsecret host configuration under Local App Data. WPF sends key bytes through
stdin to the native launcher, which stores them in Windows Credential Manager.
Inference credentials bind to the agent, provider, and canonical endpoint;
optional service credentials bind separately to the agent and service. Inference
provider keys remain in the host broker. Opted-in search and messaging keys are
delivered once through an authenticated local bootstrap into the selected agent's
process environment, without credential values in configuration JSON or process
arguments. These service integrations do not claim OpenShell-managed credential
injection or governed provider parity.

OpenClaw offers Brave and Tavily search; Hermes offers its native Tavily backend.
OpenClaw offers Telegram and Slack; Hermes also offers Discord.
Discord is deferred for the OpenClaw Windows preview because the packaged plugin
does not meet OpenClaw's trusted-provenance requirements. Setup disables that choice
and rejects it before saving configuration or copying service credentials.
Existing saved options that select OpenClaw Discord fail validation without changing
the saved file or credentials. Remove the selection through Setup before launching.
The plugin inputs remain pinned, but their presence does not establish support.
Plugin trust checks, Hermes Discord behavior, and existing data remain unchanged.
Messaging requires its selected bot/app keys;
empty sender lists keep pairing behavior, and network access does not
authorize arbitrary senders. Hermes starts its actual messaging gateway with the
interactive session, checks selected-channel connectivity, and uses the upstream
planned-stop mechanism when that session closes.

Configured OpenClaw and console agents keep their data in a stable system-drive-root
directory named `NemoClawState-<Windows account SID>-<agent>`. The native launcher
creates it with a protected current-user and SYSTEM DACL and holds exclusive
per-account, per-agent session ownership through sandbox cleanup. Reopening
retains data and checks the directory's owner, permissions, and ordinary-directory
type. Changed permissions or a reparse point stop the launch without resetting
or deleting state. Host configuration remains private in Local App Data; the
agent receives no access to the user-profile directory. The launcher does not
import arbitrary state from older preview locations. Within the retained
OpenClaw state root, configured startup detects the legacy
`.openclaw/agents/main/sessions/sessions.json` store and runs the packaged
OpenClaw dry-run and SQLite import before starting the sandbox. It holds the
private state lease throughout, rejects redirected paths and unsafe records,
and does not load agent plugins or credentials into the migration process.
Successful migration retains the upstream migration archives. A failed or
interrupted migration stops launch and retains original files and available
archives for recovery; do not delete them to force startup.

If a settings save exceeds its visible deadline, Setup keeps the transaction
helper and blocks overlapping saves. **Check save status** waits briefly for
the owned helper, then queries the installed configuration lease and recovery
record. A free lease alone does not authorize another save while that helper
remains owned. The recovery window identifies the agent, helper PID, and any
unfinished operation returned by the lease-protected query.
If repeated checks cannot confirm completion, record the displayed message,
save other work, and restart Windows through **Start > Power > Restart**.
Reopen NemoClaw Setup, check save status, review the provider and model, and
re-enter required keys before saving. Do not terminate individual Setup
processes or delete configuration, lock, or recovery files to bypass recovery.

The native Edge identity check requires certificate-chain revocation validation.
Windows may retrieve revocation evidence from certificate authorities. A revoked
chain or unavailable revocation evidence rejects launch. The check does not
disable revocation or accept signer metadata alone when validation fails.

Web UI file transport uses a native, bounded file owner. It pins the root and
stream directory handles, performs handle-relative I/O, and refuses reparse
points, hard links, path traversal, and oversized frames. Its guarded root has
an explicit MXC filesystem grant and stays pinned through sandbox teardown.
The contained relay accepts authenticated Stop requests before UI readiness and
reports connection permission failures without waiting for the readiness timeout.
Qualification saves redacted diagnostics under its evidence directory, so saving
does not depend on onboarding-created directories.

Package qualification drives the WPF controls for the included agent and
rejects browser/WebView descendants during setup. Agent-specific checks must
exercise its packaged runtime inside native MXC. The installed configured Hermes
acceptance additionally requires its visible interactive prompt, typed input,
a distinct deterministic provider response, a real console resize, exit, and
sandbox cleanup. The Hermes dashboard also requires three typed turns through
its shipped SPA and native ConPTY, then native Stop and complete cleanup.
One-shot results cannot satisfy either acceptance. Tester reset exercises the
actual maintenance data-removal option and a fresh native reinstall. Actual-window
screenshots and recordings accompany the receipts, including failed-run evidence.
The local deterministic provider proves runtime/transport wiring without a PR
credential; it does not qualify a commercial provider or live messaging account.

Native on-device Express is a separate host-owned llama.cpp/CUDA implementation
for detected RTX Spark N1X Windows ARM64 machines. With bundled inference available,
setup defaults to Qwen 3.8 27B and offers Qwen 3.6 35B-A3B as an explicit alternative.
The separate legacy Express recipe retains its pinned Qwen 3.6 35B-A3B model.
Both paths are shared across OpenClaw and Hermes and check driver compatibility, available memory
and storage, pinned downloads, full GPU offload, authentication, and an actual
model response before reporting Ready. It does not invoke the existing WSL or
Linux recipes. Model and runtime downloads occur only when selected. Generic
ARM64 package CI does not qualify N1X GPU operation; the physical device check
remains required.

This remains a preview distribution boundary. Exact candidate package evidence,
physical-host/N1X validation, commercial-provider and messaging validation,
production gateway service ownership, and Authenticode signing are separate gates.
