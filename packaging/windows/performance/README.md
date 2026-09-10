<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Windows performance measurements

This build/qualification harness compares exact Windows packages on one disposable Windows ARM64 runner. It does not optimize the runtime, change timeouts, exclude scanners, broaden ACLs, or establish full installed acceptance. The reported 142-second delay on another machine has no attached trace. Its endpoint is the first configuration **log**, not a configuration screen; the harness never substitutes one for the other.

## Measurement contract

- Bind each baseline/candidate to its source SHA, installer SHA256 and installed executable identities. Run A then B and a reversed B then A round on the same runner, recording the order. Keep ordinary timing runs separate from instrumented diagnostic runs.
- “Process cold” means the first fresh process with the specified fixture state after installation. Installation itself warms OS caches. Do not label this OS/disk-cache cold; true boot-cold comparison requires independently recorded reboot/VM state. Warm samples reuse the same explicitly recorded app fixture state and launch fresh processes. Never delete user data to manufacture a warm/cold result.
- Time successful install, uninstall and upgrade with a monotonic clock; preserve nonzero exits, reboot-required results and timeouts. A timeout is a censored failure, never a slower success. Existing product deadlines are unchanged.
- Timestamp literal child stdout/stderr bytes and complete lines when the observer receives them. Identify a configuration log only using an exact reviewed marker; absent or ambiguous markers remain unavailable. Native setup-visible, backend UI-ready, first usable screen and first model response are distinct optional controller observations.
- Inventory installed files and logical bytes **after** timing samples, so inventory does not warm metadata caches before the first launch. Preserve declaration and source-map files until the separate runtime audit proves they are unnecessary.
- Report bytes copied per launch only from an explicit runtime-copy counter or an audited file-I/O trace over the recorded staging roots. A directory's size is staged footprint, not proof of all bytes copied; process I/O includes pipes/network/device I/O and is not a file-copy counter.
- Sample idle CPU and general process-I/O counters over an exact bounded idle interval. Record process creation identity with each PID and include observer overhead. Use the separate file-I/O trace for file-only read/write/enumeration/flush attribution, including host relays.

## Diagnostic run

Use a uniquely named WPR instance, leaving unrelated sessions untouched. Probe `wpr.exe -profiles` and export the actual chosen built-in profiles before capture. Record CPU and file/disk I/O over launch through the selected log/readiness milestone, followed by a bounded idle window. Retain profile/tool identity, start/stop markers, dropped-event status and any trace-size/time cap. Missing WPR or incomplete/capped traces must be explicit, not silently treated as complete evidence. WPR file mode can grow without bound; the harness must enforce its capture budget.

Node 22 supports `--cpu-prof` and trace categories `v8`, `node.environment`, `node.module_timer`, `node.fs.sync`, `node.fs.async`, `node.fs_dir.sync`, `node.fs_dir.async`. Pass these only to a labeled diagnostic invocation with a fresh output directory. A host launcher profile does not automatically profile the contained Node process, and forced exit can prevent a CPU profile from being finalized. Record those boundaries.

Pinned OpenClaw 2026.7.1 already supports `OPENCLAW_GATEWAY_STARTUP_TRACE=1`. Its own stderr spans cover entry import, configuration snapshot/auth, plugin bootstrap and lookup, runtime state/imports, post-bind plugin work and ready; per-plugin metrics come from the official loader. Enable that switch in the diagnostic workload, with no OpenClaw source patch. Durations may overlap; do not add them into a fictitious exclusive total.

Use the three evidence layers together: Node module timers/fs events and CPU stacks for resolution/parse/evaluation; official OpenClaw spans for bootstrap/plugin boundaries; ETW process/file events for scanner activity and host relay directory scans/flushes. Scanner correlation alone does not prove causation. Do not add antivirus exclusions.

## First feasibility gate: installed read-only execution

Before designing another runtime cache, run `probe-installed-readonly.mts` against the exact installed package. It executes installed Node/OpenClaw directly from Program Files with explicit read-only runtime roots and no runtime tree copies. Probe code and writable fixture data are separately identified. Compare SDDL on the requested runtime paths/ancestors before, while MXC is active and after completion; preserve failure and cleanup receipts. Do not apply the former C:\Users path failure to Program Files without testing it.

This gate follows the pinned MXC0.8 source: paths already effectively readable/executable by the relevant AppContainer SIDs are skipped by `filter_paths_needing_grant`, and `ensure_path_grantable_for_ac` accepts their existing access without WRITE_DAC. The empirical receipt decides whether a cache is needed. The root task owns versioning, ownership and upgrade design.

## Required CI wiring

Add a manual Windows-only job after both exact installer artifacts exist. Download and verify both before timing or tracing; do not include network transfer in installation time. Reuse one `windows-11-vs2026-arm` job for both variants and the reverse-order round. Run the direct-read feasibility gate first, then uninstrumented samples, then the separately labeled WPR/Node/OpenClaw diagnostic sample. Keep evidence even on failure; do not automatically rerun, dispatch another workflow, or publish a performance claim from incomplete metrics. Restrict any eventual trigger to Windows packaging/workflow paths.

References: [WPR command-line options](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options), [WPR capture modes](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/introduction-to-wpr), [Node22 CLI](https://nodejs.org/download/release/v22.4.0/docs/api/cli.html), [Node22 trace categories](https://nodejs.org/download/release/v22.18.0/docs/api/tracing.html), [Windows process-I/O counters](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getprocessiocounters).

## Python bytecode evidence

After timing samples, run the shipped interpreter with `-B audit-python-bytecode.py ROOT OUTPUT`. The audit records each `.pyc` magic, flags, timestamp/size or checked/unchecked source hash, and agreement with the adjacent source. It does not unmarshal or execute cached code. `PYTHONDONTWRITEBYTECODE` prevents cache writes, not reads. The official Python311 distribution already ships precompiled stdlib/pip files; timestamp mismatch after copying is a hypothesis to test against these headers and actual `.py`/`.pyc` ETW read events. Use `-X importtime` only in a separately labeled diagnostic replay. Header agreement does not prove cache use, and missing read telemetry remains unknown.

## Command harness and extraction observer

`run-windows-measurement.ps1` consumes a reviewed fixture-only JSON plan of explicitly ordered cases (`id`, `variant`, `action`, exact `executable`/`sha256`/`source`, `args`, `timeoutMs`, optional exact `configurationLogMarker`, fixture-state label, diagnostic/WPR switches). It runs cases without shell command-string evaluation. Include install/uninstall/upgrade and cold/warm/idle driver cases, and an explicit inventory case after timings. The scenario driver remains responsible for its genuine ready/idle/normal-Stop boundary and fixture-state restoration; never label a returning launcher as an available agent. A missing marker is not success for that metric. Existing timeout bounds are enforced, and reboot-required or failed cases stop the comparison.

`windows-observer.ps1` can also be dot-sourced before the actual PortableGit extractor starts. Pass the real held process to `New-WindowsPerformanceObserver`, then call `Write-WindowsPerformanceSample` once per second inside its unchanged deadline. It records the exact root process's cumulative CPU/general I/O, visible owned window/control class/title/enabled state, and a bounded file-growth watcher. Edit text is not collected. Root-process counters do not imply descendant coverage; file growth is observed footprint, not bytes copied. The observer does not click windows, stop processes or change ACLs. File-watcher overflow/capture cost are explicit. Empty stdout plus an idle process alone does not prove a GUI prompt.

`comparisonPlan()` builds 28 explicitly ordered ABBA cases: install; one first fresh process; two warm fresh processes; an owned idle driver; inventory; uninstall, repeated baseline/candidate/candidate/baseline. A compatible, explicitly supported forward upgrade adds three cases; otherwise the upgrade metric remains unavailable. The inputs are exact installer identities and reviewed finite launch/idle driver commands. Each driver must keep its actual child/session owned until its genuine endpoint and Stop; substitute `{{caseDirectory}}` and `{{sampleKind}}` in its literal arguments. Pin driver source files using `driverFiles` as well as the executable. `summarizeComparison()` retains raw successful timing arrays and missing markers, without interpreting launcher exit as a usable interface.

Ordinary launch/install timing cases do not attach the process/window/file-growth observer. Idle counter cases and diagnostic cases are separately labeled. Hash verification occurs before the command clock, and necessarily reads the measured executable; these are fresh-process samples, not OS-cold claims. WPR and Node traces must be requested in separate replay cases. For PortableGit extraction diagnostics, keep the corrected dedicated SFX argument renderer and attach the observer there; the generic command runner is not a replacement for that SFX-specific raw command-line contract.

The source revision in a command receipt comes from the reviewed plan. The CI controller must first verify the installer artifact digest/source and later installed runtime identities; the harness does not derive Git provenance from an executable hash alone. Plan arguments and literal output are diagnostic artifacts and must use disposable fixture data without credentials. Do not supply user prompts or secret-bearing command arguments.

## Partial recorder windows and target deadlines

The explicit f8 profiling phase records the first system-drive preparation and MSI
in separate windows of the **same original bundle command**. Exact complete Burn
`i301`/`i319` package records select the phases. The receipt retains their log
clock, observer clock, recording-start lag and any missing phase. The observer
can miss a very short phase; it never synthesizes its trace or calls these complete
operation recordings. Warm host preparation and dashboard ETW use command-prefix
windows. The full command result and separate Node CPU/module/startup traces keep
their own identities; a short ETW window does not establish complete attribution.

Each recorder window stops at 256 MiB of observed logical files or 45 seconds,
checked every 100 ms. Enumeration includes hidden/system files and records their
actual attributes. Windows sizes come from a metadata-only `FILE_READ_ATTRIBUTES`
handle and `GetFileSizeEx`; the potentially stale directory-enumeration size is
retained separately. A failed size query fails the recorder rather than counting
zero. This is a **stop threshold, not a filesystem quota**: buffered
writes, polling lag and finalization can add bytes. Final file sizes and stop time
are recorded separately. The earlier failed run's ZIP normalized file attributes,
so it cannot prove that the missed live files were hidden. It did retain multi-GB
raw ETLs and a failed 60-second stop; neither is a product performance result.

The owned recorder uses documented `-skipPdbGen`, retaining native event data but
omitting dynamic .NET NGen/embedded PDB generation. Stop remains bounded to 60
seconds; status to five seconds and owned cancellation to ten. Partial stdout and
stderr are saved even on timeout, both as readable text and exact bounded raw
prefixes. Collector and measured-command output are retained separately. A recorder
failure never terminates the installer or agent. Confirmed recorder cleanup permits
later diagnostic cases, while the overall phase remains failed. Unconfirmed cleanup
prevents any later case. A target failure remains primary over recording failures.

Only the exact reviewed f8 OpenClaw replay may exceed the generic 15-minute harness
cap. Its installed qualification controller already allows 1,200 seconds. The
profiling child allows that interval plus the explicit 30-second diagnostic idle
and 90 seconds for cleanup/harvest; its outer collector allows another 30 seconds.
The product's own startup/turn/shutdown deadlines are unchanged. An outer deadline
or the existing 256 MiB Node trace limit still censors a replay and must stay failed.
The 150-minute profiling job covers the bounded install, two warm preparations,
two replay allowances and uninstall, with download/recorder headroom. It is not a
performance improvement or a new application timeout.

Before WPR smoke, the job runs portable recorder lifecycle controls against real
owned Node children and files. Controlled WPR outcomes in those tests are explicitly
not WPR API or installed-application proof. The smoke and actual replay provide the
Windows recorder evidence. See [Microsoft's recorder options](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options)
and [PowerShell file enumeration](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-childitem).
