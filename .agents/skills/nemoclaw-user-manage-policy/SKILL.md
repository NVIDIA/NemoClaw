---
name: "nemoclaw-user-manage-policy"
description: "Adds, removes, or modifies allowed endpoints in the sandbox policy. Use when customizing network policy, changing egress rules, or configuring sandbox endpoint access. Trigger keywords - customize nemoclaw network policy, sandbox egress policy configuration, nemoclaw integration policy examples, post-install policy setup, openshell approval workflow, policy preset, nemoclaw approve network requests, sandbox egress approval tui."
license: "Apache-2.0"
---

# Customize the Sandbox Network Policy

## Gotchas

- Adding a host to the egress policy permits the connection only after the endpoint, port, method, and binary rules match.
- Custom preset hosts bypass NemoClaw's review process and can widen sandbox egress to arbitrary destinations.

## Prerequisites

- A running NemoClaw sandbox for dynamic changes, or the NemoClaw source repository for static changes.
- The OpenShell CLI on your `PATH`.

import { AgentOnly } from "../_components/AgentGuide";

Add, remove, or modify the endpoints the sandbox can reach.

The NemoClaw repository defines the sandbox policy in a declarative YAML file, and [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) enforces it at runtime.
NemoClaw supports both static policy changes that persist across restarts and dynamic updates applied to a running sandbox through the OpenShell CLI.

**Note:**

If the sandbox needs to reach an HTTP service running on the host, expose the service on a host IP that the OpenShell gateway can reach.
Apply a custom NemoClaw preset with `nemoclaw <sandbox> policy-add --from-file`.
Do not rely on `host.docker.internal` as a general host-service path because it bypasses the OpenShell policy path and may not be reachable in every sandbox runtime.
See Agent cannot reach a host-side HTTP service (use the `nemoclaw-user-reference` skill).

**Warning:**

Adding a host to the egress policy permits the connection only after the endpoint, port, method, and binary rules match.
OpenShell still applies SSRF protection separately, so a request can be denied if the final address resolves to a loopback, private, link-local, or otherwise blocked internal range.
If a package installer or browser runtime download still fails with an SSRF-style denial after you add the public host, install that binary into the sandbox image at build time with `nemoclaw onboard --from` (use the `nemoclaw-user-reference` skill) instead of relying on runtime egress.

## Static Changes

Static changes modify the baseline policy file and take effect after the next sandbox creation.

### Edit the Policy File

<AgentOnly variant="openclaw">
Open `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` and add or modify endpoint entries.

If you want a built-in preset to be part of the baseline policy, merge its `network_policies` entries into this file and re-run `nemoclaw onboard`.

If you only need to apply a preset to a running sandbox, use `nemoclaw <name> policy-add` under [Dynamic Changes](#dynamic-changes).
That updates the live policy and does not edit `openclaw-sandbox.yaml`.
</AgentOnly>
<AgentOnly variant="hermes">
Open the Hermes policy additions and shared sandbox policy files under `agents/hermes/` and `nemoclaw-blueprint/policies/`, then add or modify endpoint entries.

If you want a built-in preset to be part of the baseline policy, merge its `network_policies` entries into the appropriate policy file and re-run `nemoclaw onboard`.

If you only need to apply a preset to a running sandbox, use `nemoclaw <name> policy-add` under [Dynamic Changes](#dynamic-changes).
That updates the live policy and does not edit the baseline policy files.
</AgentOnly>

Use a manual YAML edit when you need to allow custom hosts that are not covered by a preset, such as an internal API or a weather service.

Each entry in the `network` section defines an endpoint group with the following fields:

`endpoints`
: Host and port pairs that the sandbox can reach.

`binaries`
: Executables allowed to use this endpoint.

`rules`
: HTTP methods and paths that are permitted.

### Re-Run Onboard

Apply the updated policy by re-running the onboard wizard:

```bash
nemoclaw onboard
```

The wizard reads the modified policy file and applies it to the sandbox.

### Verify the Policy

Check that the sandbox is running with the updated policy:

```bash
nemoclaw <name> status
```

### Add Blueprint Policy Additions

If you maintain a custom blueprint, you can add extra policy entries under `components.policy.additions` in `nemoclaw-blueprint/blueprint.yaml`.
NemoClaw validates those entries with the same policy schema used by preset files, fetches the live policy during sandbox creation, merges the additions into `network_policies`, and applies the merged policy through OpenShell.
The applied additions are recorded in the run metadata so you can audit which blueprint-level policy entries were active for that sandbox run.

## Dynamic Changes

Dynamic changes apply a policy update to a running sandbox without restarting it.

> [!WARNING]
> `openshell policy set` **replaces** the sandbox's live policy with the contents of the file you provide; it does not merge.
> A running sandbox's live policy is the baseline policy plus every preset that was layered on during onboarding.
> Applying a file that contains only the baseline (or only a single preset) silently drops every other preset that was in effect.

### Option 1: Drop a Preset File and Use `policy-add` (Recommended)

This is the non-destructive path and the only flow NemoClaw supports out of the box for merging new entries into a running policy.

1. Create a preset-format YAML file under `nemoclaw-blueprint/policies/presets/`, for example `nemoclaw-blueprint/policies/presets/influxdb.yaml`:

   ```yaml
   preset:
     name: influxdb
     description: "InfluxDB time-series database"
   network_policies:
     influxdb:
       name: influxdb
       endpoints:
         - host: influxdb.internal.example.com
           port: 8086
           protocol: rest
           enforcement: enforce
           rules:
             - allow: { method: GET, path: "/**" }
             - allow: { method: POST, path: "/api/v2/write" }
       binaries:
         - { path: /usr/bin/curl }
   ```

2. Apply it to the running sandbox:

```bash
nemoclaw my-assistant policy-add
```

NemoClaw reads the live policy via `openshell policy get --full`, structurally merges your preset's `network_policies` into it, and writes the merged result back.
Existing presets and the baseline remain in place.
The preset file under `presets/` also persists across sandbox recreations.

### Option 2: Snapshot, Edit, and Set with OpenShell

Use this path only when you cannot add a file under the NemoClaw source tree.
You must start from the **live** policy, not from a baseline policy file, so the presets layered on at onboarding are preserved in the file you apply.

```bash
openshell policy get --full my-assistant > live-policy.yaml
```

Edit `live-policy.yaml` to add your entries under `network_policies:`, keeping the existing `version` field intact, then apply:

```bash
openshell policy set --policy live-policy.yaml my-assistant
```

### Scope of Dynamic Changes

Dynamic changes apply only to the current session.
When the sandbox stops, the running policy resets to the baseline policy plus the presets recorded for the sandbox.
Custom presets applied through `nemoclaw <sandbox> policy-add --from-file` or `--from-dir` are recorded with the sandbox, including their full YAML content.
Snapshot restore and rebuild replay those recorded presets, so they survive sandbox recreation even if the original files are no longer on disk.
For permanent baseline changes that apply to every future sandbox, edit the source policy for the target agent and re-run `nemoclaw onboard`.

### Approve Requests Interactively

For one-off access, you can approve blocked requests in the OpenShell TUI instead of editing the baseline policy:

```bash
openshell term
```

This is useful when you want to test a destination before deciding whether it belongs in a permanent preset or custom policy file.

## Policy Presets

NemoClaw ships preset policy files for common integrations in `nemoclaw-blueprint/policies/presets/`.
Apply a preset as-is or use it as a starting template for a custom policy.
For guided post-install examples, see [Common Integration Policy Examples](references/integration-policy-examples.md).

During onboarding, the policy tier (use the `nemoclaw-user-reference` skill) you select determines which presets are enabled by default.
You can add or remove individual presets in the interactive preset screen that follows tier selection.

Available presets:

| Preset | Endpoints |
|--------|-----------|
| `brave` | Brave Search API |
| `brew` | Homebrew (Linuxbrew) package manager |
| `discord` | Discord API, gateway, and CDN access |
| `github` | GitHub and GitHub REST API |
| `huggingface` | Hugging Face Hub (download-only) and inference router |
| `jira` | Atlassian Jira API |
| `local-inference` | Local Ollama and vLLM through the host gateway |
| `npm` | npm and Yarn registries |
| `openclaw-pricing` | OpenClaw model-pricing reference fetch (LiteLLM and OpenRouter) |
| `outlook` | Microsoft 365 and Outlook |
| `pypi` | Python Package Index |
| `slack` | Slack API and webhooks |
| `telegram` | Telegram Bot API |
| `wechat` | WeChat (personal) iLink Bot API (experimental) |
| `whatsapp` | WhatsApp Web messaging (experimental) |

To apply a preset to a running sandbox:

```bash
nemoclaw <name> policy-add
```

**Note:**

Preset selection is interactive when you omit a preset name.
Pass a preset name with `--yes` for scripted workflows.

For example, to interactively add PyPI access to a running sandbox:

```bash
nemoclaw my-assistant policy-add
```

To list which presets are applied to a sandbox:

```bash
nemoclaw <name> policy-list
```

<AgentOnly variant="openclaw">
To include a preset in the baseline, merge its entries into `openclaw-sandbox.yaml` and re-run `nemoclaw onboard`.
</AgentOnly>
<AgentOnly variant="hermes">
To include a preset in the baseline, merge its entries into the Hermes policy additions and re-run `nemoclaw onboard`.
</AgentOnly>

**Note:**

The `openshell policy set --policy <file> <sandbox-name>` command operates on raw policy files and does not accept the `preset:` metadata block used in preset YAML files.
Use `nemoclaw <name> policy-add` for presets.

For scripted workflows, `policy-add` and `policy-remove` accept the preset name as a positional argument:

```bash
nemoclaw my-assistant policy-add pypi --yes
nemoclaw my-assistant policy-remove pypi --yes
```

Set `NEMOCLAW_NON_INTERACTIVE=1` instead of `--yes` to drive the same flow from an environment variable.
See Commands (use the `nemoclaw-user-reference` skill) for the full flag reference.

`nemoclaw <name> rebuild` reapplies every policy preset to the recreated sandbox, so presets survive an agent-version upgrade without manual reapplication.

## Custom Preset Files

Apply a user-authored preset YAML to a running sandbox without editing the baseline or dropping to `openshell policy set`.

### Authoring

A custom preset follows the same shape as the built-in ones under `nemoclaw-blueprint/policies/presets/`:

```yaml
preset:
  name: my-internal-api
  description: "Internal service"
network_policies:
  my-internal-api:
    name: my-internal-api
    endpoints:
      - host: api.example.internal
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
    binaries:
      - { path: /usr/local/bin/node }
```

The top-level `preset.name` must be a lowercase RFC 1123 label (letters, digits, hyphens) and must not collide with a built-in preset name such as `slack` or `pypi`.
Rename `preset.name` if NemoClaw refuses to apply the file because of a collision.

### Apply a Single File

```bash
nemoclaw my-assistant policy-add --from-file ./presets/my-internal-api.yaml
```

Preview the endpoints without applying with `--dry-run`, and skip the confirmation prompt with `--yes` or by exporting `NEMOCLAW_NON_INTERACTIVE=1`.

### Apply Every File in a Directory

```bash
nemoclaw my-assistant policy-add --from-dir ./presets/ --yes
```

Files are processed in lexicographic order.
Processing stops at the first failure; presets already applied are not rolled back.
Fix the failing file and re-run the command to continue.

**Warning:**

Custom preset hosts bypass NemoClaw's review process and can widen sandbox egress to arbitrary destinations.
Review every host in a custom preset before applying it, especially when the file originates outside your team.

### Remove a Custom Preset

NemoClaw records custom presets applied with `--from-file` or `--from-dir` in the sandbox registry alongside their full YAML content.
You can remove them by name without keeping the original file on disk:

```bash
nemoclaw my-assistant policy-remove my-internal-api --yes
```

`policy-remove` accepts both built-in and custom preset names. Run `nemoclaw <name> policy-list` to see every preset currently applied to the sandbox.

## Agent Policy Context

When an agent runs in the sandbox, it needs a compact view of the active policy so it can decide whether a host or integration is allowed and what to suggest when something fails.
`nemoclaw <name> policy-explain` prints that view as a redacted summary: the recorded tier, the applied presets and their allowed host categories, the known presets that are not applied, the inspect/add/remove commands that change policy, and the support boundaries between NemoClaw, OpenShell, and the agent.

```bash
nemoclaw my-assistant policy-explain
```

Pass `--json` to emit the same context as a structured object the agent can read:

```bash
nemoclaw my-assistant policy-explain --json
```

NemoClaw also seeds the rendered context inside the sandbox at `/sandbox/.openclaw/workspace/POLICY.md` once during onboarding and refreshes it on every `policy-add` or `policy-remove`, so the in-sandbox agent picks it up when it scans the workspace.
Pass `--write` to refresh that file on demand without changing the policy:

```bash
nemoclaw my-assistant policy-explain --write
```

The output is intentionally redacted.
Network policy rule bodies, credential metadata, and binary allowlists are not included; only host stems and category-level summaries appear.
Host stems that resolve to RFC 1918 ranges (10/8, 172.16/12, 192.168/16), loopback (127/8, `::1`), link-local (169.254/16, `fe80::/10`), cloud metadata (`169.254.169.254`), unique-local IPv6 (`fc00::/7`), reserved zero (0.0.0.0/8), CGNAT (100.64/10), benchmarking (198.18/15), `localhost`, and the internal DNS suffixes `.local`, `.internal`, `.lan`, `.home`, `.home.arpa`, `.corp`, `.intra`, `.intranet`, `.localdomain` are dropped from `allowedHostCategories` and surface as a `redactedHostCount`.

Each active preset also carries a `verification` field that tells the agent whether the OpenShell gateway actually enforces it:

| Status | Meaning |
|--------|---------|
| `verified` | Registry lists the preset and the gateway confirms it is enforced. Safe to treat the host stems as allowed. |
| `registry-only` | Registry lists the preset but the gateway does not enforce it (drift). Treat allowed hosts as unverified; the agent should not assume the traffic will reach the host. |
| `gateway-only` | Gateway enforces a preset the registry does not list. Reported as active so the agent does not misclassify allowed hosts as blocked. |
| `gateway-unavailable` | Could not probe the gateway (no live snapshot). The whole report is advisory; rely on `nemoclaw <sandbox> policy-list` once the gateway is reachable. |

The context also documents how the agent should classify a failed host or integration attempt.
The rules are evaluated in order so HTTP 403 has a single interpretation per call: when the host matches an applied preset the request is treated as an authentication failure, otherwise as a policy denial.

1. `unsupported` — the caller asserts the capability is not offered for this sandbox (for example, a messaging channel that the active agent does not support). The agent should surface the limitation without retrying.
2. `missing-approval` — the host **is** allowed by an applied preset and the request was refused with HTTP 401. The network path is open; credentials are missing or invalid.
3. `missing-approval` (low confidence) — the host **is** allowed by an applied preset and the request was refused with HTTP 403. Ambiguous: OpenShell policies enforce by method, path, protocol, and binary, so a 403 on an allowed host can still be a finer-grained policy denial rather than missing credentials. Confirm credentials first, then run `openshell policy get` to check whether the specific method or path is blocked.
4. `blocked-by-policy` — either the host is **not** allowed by any applied preset and either an existing built-in or custom preset declares it (apply that preset), or the request is refused with a network-block error code (`EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`) or HTTP 403. The same network-block codes also surface as `blocked-by-policy` (low confidence) when the host is on an applied but **unverified** preset (`registry-only` or `gateway-unavailable`), because a block code on a host the registry says should be allowed is the strongest signal that the gateway is not enforcing the preset.
5. `unknown` — none of the above apply; the agent should surface the underlying error. A network-block code on a host that matches a **verified** preset stays `unknown` because the gateway has confirmed enforcement, so the block must be an upstream connectivity failure rather than a policy denial.

Each classification also carries a `confidence` field set to `high` or `low`. Low-confidence verdicts mean the agent should report multiple possibilities to the user instead of treating the next-step recommendation as authoritative. Common low-confidence triggers are:

- HTTP 403 on an active host (ambiguous between missing credentials and a finer-grained OpenShell denial by method, path, protocol, or binary).
- The matched preset is `registry-only` (the registry lists it but the gateway does not enforce it) — the agent must not assume the host is reachable.
- The matched preset is `gateway-unavailable` (no live gateway snapshot was available) — the verdict is registry-derived and advisory.

Callers that already hold a verified gateway snapshot can pass it to the classifier so verdicts about hosts on verified presets stay high-confidence.

Use the classification to pick the next step.
For `blocked-by-policy`, run `nemoclaw <name> policy-add <preset>` or author a [custom preset](#custom-preset-files).
For `missing-approval`, confirm the API token and scopes for the integration.
For `unsupported`, surface the limitation to the user without retrying.

## References

- **[references/integration-policy-examples.md](references/integration-policy-examples.md)** — Guides users through common post-install integration policy setup for maintained NemoClaw policy presets, including Outlook, messaging channels, GitHub, Jira, Brave Search, package managers, Hugging Face, local inference, and OpenShell approval workflows.
- **Load [references/approve-network-requests.md](references/approve-network-requests.md)** when approving or denying sandbox egress requests, managing blocked network calls, or using the approval TUI. Reviews and approves blocked agent network requests in the TUI.

## Related Skills

- [Approve or Deny Agent Network Requests](references/approve-network-requests.md) for real-time operator approval.
- [Common Integration Policy Examples](references/integration-policy-examples.md) for maintained preset examples such as Outlook, messaging, GitHub, Jira, Brave Search, package managers, Hugging Face, and local inference.
- `nemoclaw-user-reference` — Network Policies (use the `nemoclaw-user-reference` skill) for the full baseline policy reference
- OpenShell [Policy Schema](https://docs.nvidia.com/openshell/latest/reference/policy-schema.html) for the full YAML policy schema reference.
- OpenShell [Sandbox Policies](https://docs.nvidia.com/openshell/latest/sandboxes/policies.html) for applying, iterating, and debugging policies at the OpenShell layer.
