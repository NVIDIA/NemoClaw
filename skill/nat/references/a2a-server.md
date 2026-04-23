# A2A Server Configuration

Publish NAT workflows as A2A agents for discovery and invocation.

## Installation

```bash
uv pip install "nvidia-nat[a2a]"
```

## Basic Usage

```bash
nat a2a serve --config_file workflow.yml
# Server starts on http://localhost:10000
# Agent Card at http://localhost:10000/.well-known/agent-card.json
```

## Server Options

```bash
nat a2a serve --config_file workflow.yml \
  --host 0.0.0.0 \
  --port 11000 \
  --name "Calculator Agent" \
  --description "A calculator agent for mathematical operations"
```

## Configuration File Approach

```yaml
general:
  front_end:
    _type: a2a
    name: "Calculator Agent"
    description: "A calculator agent for mathematical operations"
    host: localhost
    port: 10000
    public_base_url: "https://agents.example.com/calculator"
    version: "1.0.0"
    max_concurrency: 16  # default: 8
```

## How Workflows Map to A2A

- Workflow becomes an Agent
- Functions become Skills (auto-namespaced)
- Agent Card is auto-generated from workflow metadata

## Client Commands

```bash
# Discover
nat a2a client discover --url http://localhost:10000
curl http://localhost:10000/.well-known/agent-card.json | jq

# Call
nat a2a client call --url http://localhost:10000 --message "What is 42 * 67?"
```

## Get Full Schema

```bash
nat info components -t front_end -q a2a
```

## Kubernetes / Ingress

Set `public_base_url` so the Agent Card advertises the external URL:

```yaml
general:
  front_end:
    _type: a2a
    host: 0.0.0.0
    port: 10000
    public_base_url: ${NAT_PUBLIC_BASE_URL}
```

## Authentication

A2A servers support OAuth2 with JWT token validation:
- Token signature via JWKS
- Issuer validation
- Expiration checks
- Scope and audience validation

## Troubleshooting

```bash
# Port in use
lsof -i :10000
nat a2a serve --config_file config.yml --port 11000
```
