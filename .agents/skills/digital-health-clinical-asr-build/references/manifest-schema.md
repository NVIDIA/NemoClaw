# Manifest schema — NeMo canonical + clinical extension

The Clinical ASR Flywheel manifest is **NeMo-format JSONL** with a small clinical extension. One JSON object per line. This file documents the schema, pre-flight checks, and cross-cycle stability rules. Path-rewriting for cross-host portability is in the finetune skill's `references/container-paths.md`.

## NeMo canonical fields (required by every NeMo loader)

| Field | Type | Notes |
|---|---|---|
| `audio_filepath` | string | **Absolute path** to the WAV. Use absolute paths so the manifest is portable across cwd. |
| `text` | string | Reference transcript. Lowercased by most NeMo configs downstream. |
| `duration` | float \| null | Audio length in seconds. Write `null` — NeMo loaders fill via librosa. Some training configs require it pre-populated; check `/riva-asr-custom`. |

## Clinical extension fields (load-bearing for eval breakdowns)

| Field | Type | Why |
|---|---|---|
| `term` | string | The clinical entity. Powers per-term KER. |
| `entity_category` | string | One of `drug \| procedure \| anatomy \| condition \| lab \| role`. KER-by-category split. **Fixed vocabulary** — KER aggregation depends on it. |
| `ipa_source` | string | One of `override \| merriam-webster \| magpie_g2p`. **The most informative leaderboard split** — proves the SSML override pipeline is doing real work. |
| `voice_id` | string | TTS voice (e.g. `Magpie-Multilingual.EN-US.Mia`). KER-by-voice split for fairness checks. |
| `noise_level` | string | `clean \| snr_15db \| snr_5db` or whatever the user defined. |
| `context_type` | string | `dictation \| handoff \| chart_note \| history` or user-defined. |

Stripping the clinical fields is safe for handing off to a generic NeMo SFT job — they're harmless but bloat the manifest. **Don't strip them before scoring**; the leaderboard splits depend on them.

## One-row example

```json
{
  "audio_filepath": "$HOME/clinical_eval/cycle1/audio/cefazolin_dictation_Mia_clean.wav",
  "text": "the patient was started on intravenous cefazolin one gram every eight hours",
  "duration": null,
  "term": "cefazolin",
  "entity_category": "drug",
  "ipa_source": "override",
  "voice_id": "Magpie-Multilingual.EN-US.Mia",
  "noise_level": "clean",
  "context_type": "dictation"
}
```

## Pre-flight checks (run before Stage 3)

**Schema check.** Confirm every row has the canonical required fields:

```bash
python3 -c "
import json
required = ('audio_filepath', 'text')
with open('$MANIFEST_PATH') as f:
    for i, line in enumerate(f, 1):
        e = json.loads(line)
        for k in required:
            assert k in e, f'row {i} missing {k}'
print('manifest schema OK')
"
```

**Clinical-extension check.** Confirm the clinical fields are present and well-formed:

```bash
python3 -c "
import json
clinical = ('term', 'entity_category', 'ipa_source', 'voice_id', 'noise_level', 'context_type')
categories = {'drug', 'procedure', 'anatomy', 'condition', 'lab', 'role'}
sources    = {'override', 'merriam-webster', 'magpie_g2p'}
with open('$MANIFEST_PATH') as f:
    for i, line in enumerate(f, 1):
        e = json.loads(line)
        for k in clinical:
            assert k in e, f'row {i} missing clinical field {k}'
        assert e['entity_category'] in categories, f'row {i} bad entity_category {e[\"entity_category\"]!r}'
        assert e['ipa_source'] in sources, f'row {i} bad ipa_source {e[\"ipa_source\"]!r}'
print('clinical extension OK')
"
```

**Audio existence check.** Confirm every `audio_filepath` actually resolves on disk:

```bash
python3 -c "
import json, os
missing = []
with open('$MANIFEST_PATH') as f:
    for line in f:
        p = json.loads(line)['audio_filepath']
        if not os.path.exists(p):
            missing.append(p)
print(f'{len(missing)} missing files' if missing else 'all audio present')
"
```

If audio is missing, **regenerate** via Stage 2e. Do not edit paths manually unless you have a clear reason (cross-host move — see the finetune skill's `references/container-paths.md`).

## Cross-cycle stability

The schema is **stable across cycles**. Re-running Stage 2 with new terms produces additional rows; existing rows shouldn't change unless the user explicitly modifies `pronunciation_overrides.csv` (which can flip `ipa_source` from `magpie_g2p` to `override` for affected rows on the next regeneration).

Keep prior cycles' manifests committed — Stage 3 leaderboards diff cycle N vs cycle N+1 KER, so both versions matter.

## Don'ts

- **Don't put non-UTF-8 characters in `text`.** Some clinical sources contain stray byte-order marks or smart quotes — strip them at generation time.
- **Don't put commas in `term`** if you ever plan to read the manifest with a naïve CSV tool. JSONL is fine; downstream CSV-derived reports may break.
- **Don't pre-populate `duration` from a different soundfile library than NeMo uses internally.** Off-by-one rounding causes Lhotse's `DurationFilter` to drop rows silently. Either leave `null` or populate via NeMo's own `read_manifest` round-trip.
- **Don't symlink WAVs across cycles** to "save space." Cycle isolation is a feature — when you grow the manifest in cycle N+1 and re-eval, you want to know exactly which rows are new and which carried over.
- **Don't strip the clinical extension fields before scoring.** The Stage 3 leaderboard's three most useful sections (by-category, by-`ipa_source`, by-noise) all depend on them.
