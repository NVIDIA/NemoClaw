# CLI Deployment

Use this path when the user wants an interactive terminal research assistant rather than a web UI or Docker Compose stack.

## Prerequisites

```bash
python3 --version
uv --version
test -d .venv && echo "venv=present" || echo "venv=missing"
```

If `.venv` is missing, use the repository's documented setup flow before starting the CLI. Ask before installing dependencies.

## Start

```bash
./scripts/start_cli.sh
```

For a non-default config:

```bash
./scripts/start_cli.sh --config_file configs/config_cli_default.yml
```

The CLI mode is useful for direct terminal interaction, but it does not provide the local web server expected by `aiq-research`. Use local web or Docker Compose when the user wants deploy-to-research handoff.
