# Install NAT from Source (Development)

```bash
git clone -b main https://github.com/NVIDIA/NeMo-Agent-Toolkit.git nemo-agent-toolkit
cd nemo-agent-toolkit
git submodule update --init --recursive
git lfs install
git lfs fetch
git lfs pull
uv venv --python 3.13 --seed .venv
source .venv/bin/activate
uv sync --all-groups --extra most
```

Verify:

```bash
nat --help
nat --version
```
