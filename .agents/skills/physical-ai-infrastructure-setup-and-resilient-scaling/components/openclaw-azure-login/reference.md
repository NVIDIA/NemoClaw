# OpenClaw Azure Login

## Purpose

Use Azure CLI device-code flow when `az login` cannot launch a browser or the
chat surface cannot host interactive auth.

## Procedure

1. Check current auth:

```bash
az account show --query "{name:name,id:id,tenantId:tenantId,user:user.name}" -o table
```

If it succeeds and the subscription is correct, return to
`components/azure-access/reference.md` for PIM/role, provider, and region
checks.

2. Start device-code login. Use a tenant only when the user or org config gives
one; otherwise omit `--tenant`.

```bash
az login --use-device-code
az login --use-device-code --tenant <tenant-id-or-domain>
```

Do not use `--output none`; the agent must see the code and link. Do not run
bare `az login` in OpenClaw.

Use a streaming shell/session. If the shell tool returns a session ID, poll
until the code appears, then tell the user immediately; do not wait for login
completion before sharing the code.

3. When the CLI prints device instructions, immediately send the user:

```text
Open https://microsoft.com/devicelogin
Enter code: <code from az login output>
Then tell me "done" here.
```

Copy the exact code from the current command output. If Azure CLI prints a
different URL, use that exact URL. Keep the login command running while the
user completes auth. Do not start a second login unless the first expires or
fails; it changes the code.

4. After the command exits, verify:

```bash
az account show --query "{name:name,id:id,tenantId:tenantId,user:user.name}" -o table
```

If the wrong subscription is selected, ask the user for the subscription ID or
name, then run:

```bash
az account set --subscription <subscription-id-or-name>
az account show --query "{name:name,id:id,tenantId:tenantId,user:user.name}" -o table
```

## Failure Handling

- `AADSTS...` or tenant denied: rerun with `--tenant <tenant-id>` if the user
  or org config gives one; otherwise ask for the tenant.
- Code expired: rerun device-code login and send the fresh code/link.
- `PermissionError` writing Azure CLI config: request permission for the Azure
  CLI config directory or set `AZURE_CONFIG_DIR` to a user-private ignored
  path. Never commit Azure tokens or put them in `.env`.
- No subscriptions: stop before Terraform or Foundry work; the user must switch
  account/tenant or get subscription access.
- Conditional Access/MFA delay: leave the login command running; verify with
  `az account show` only after it exits.

## Handoff

Return to `components/azure-access/reference.md`, then the selected Azure skill:

- Cluster: `skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/reference.md`
- Inference: `skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-azure/reference.md`
- Osmo: `skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/osmo-azure/reference.md`
