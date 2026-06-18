# Container paths — cross-host manifest portability

The manifest's `audio_filepath` is whatever absolute path the build host used when synthesizing. When you move the manifest to a different host (laptop → Brev) or into a container (host → NeMo container), those paths don't resolve. NeMo's training loader treats every missing path as a row-load failure and silently drops the row — symptom: training "works" but converges on a much smaller dataset than expected.

This file documents the rewrite.

## Common moves

| Move | `audio_filepath` looks like | Fix to |
|---|---|---|
| Laptop → Brev instance | `$HOME/…` on Brev (doesn't exist) | `$HOME/…` (or wherever you rsync'd the data) |
| Laptop → NeMo container | `$HOME/…` mounted into `/workspace` | `/workspace/…` |
| Brev host → NeMo container on Brev | `$HOME/…` mounted into `/workspace` | `/workspace/…` |

## Two strategies

### (a) Use relative paths from the start

Make the manifest's `audio_filepath` relative to a known root (the manifest's directory, conventionally). Every consumer joins against that root. Cleanest, but requires every downstream consumer to know the convention. NeMo's loader supports relative paths if `manifest_filepath` itself is absolute and the audio sits under that directory tree.

### (b) Rewrite explicitly when moving

Run this one-liner before training (or before each move):

```bash
python3 -c "
import json, sys
PREFIX_FROM, PREFIX_TO = sys.argv[1], sys.argv[2]
for line in sys.stdin:
    row = json.loads(line)
    p = row['audio_filepath']
    if p.startswith(PREFIX_FROM):
        row['audio_filepath'] = PREFIX_TO + p[len(PREFIX_FROM):]
    print(json.dumps(row))
" '$HOME/repo' '/workspace' < manifest.jsonl > manifest.rewritten.jsonl
```

Both options work. For long-lived cycle directories, (a) is simpler — pick a path that's the same on the host and inside the container, and you never have to rewrite. For ad-hoc runs, (b) is more flexible.

## Verify before training

After rewriting, run the audio-existence pre-flight from the build skill's `references/manifest-schema.md`:

```bash
python3 -c "
import json, os
missing = []
with open('manifest.rewritten.jsonl') as f:
    for line in f:
        p = json.loads(line)['audio_filepath']
        if not os.path.exists(p):
            missing.append(p)
print(f'{len(missing)} missing files' if missing else 'all audio present')
"
```

If any rows are missing, the rewrite has the wrong prefix or the data isn't fully mounted into `/workspace`. **Do not train past missing audio** — NeMo silently drops missing rows and you'll converge on a smaller-than-intended dataset.

## Don'ts

- **Don't symlink WAVs across hosts** to "save space." `os.path.exists()` follows symlinks correctly, but rsync's `-l` flag is easy to forget and a broken symlink is harder to debug than a missing file.
- **Don't edit `audio_filepath` in-place** in the original manifest. Always write a `.rewritten.jsonl` copy — you'll want the original when you eventually move the manifest somewhere else.
- **Don't put the rewrite logic inside the training script.** Keep manifest mutation upstream of training so you can re-train against the same rewritten manifest deterministically.
