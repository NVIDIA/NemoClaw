# Locate Or Clone AI-Q

Use this reference when the user has not already pointed to an AI-Q checkout.

## Detect Existing Checkout

From the current workspace, look for an AI-Q repository before cloning:

```bash
test -f pyproject.toml && test -d deploy && test -d skills && test -L .agents/skills && echo "aiq_repo=."
find .. -maxdepth 3 -name pyproject.toml -print 2>/dev/null
```

Confirm a candidate by checking:

```bash
test -f pyproject.toml
test -f deploy/.env.example
test -f deploy/compose/docker-compose.yaml
test -f scripts/start_as_skill.sh
test -f scripts/start_e2e.sh
```

If these files exist, work from that repository root.

## Clone When Missing

If no checkout exists, clone the public AI-Q repository:

```bash
git clone https://github.com/NVIDIA-AI-Blueprints/aiq.git
```

Then enter the checkout and verify:

```bash
cd aiq
git status -sb
test -f pyproject.toml
test -f deploy/.env.example
test -f deploy/compose/docker-compose.yaml
```

If clone fails because Git LFS is unavailable, continue only if the source tree is usable for deployment. Tell the user if large LFS-backed assets may require installing Git LFS.

## Branch Choice

For external users, default to the repository's default branch. Use a release branch, PR branch, or fork only when the user explicitly asks.
