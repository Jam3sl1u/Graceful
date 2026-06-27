# song2score

Transcribe a song (audio file) into sheet music, in any user-chosen key.

## Goal
Audio (mp3/wav) → sheet music (MusicXML / PDF), transposable to any key.
Core thesis: most transcription tools are inaccurate because they transcribe a
dense full mix directly. We separate into stems FIRST, transcribe each stem
with constrained settings, then merge. Later we add a model to fix residual errors.

## Pipeline stages
1. **Source separation** — Demucs (htdemucs / htdemucs_6s) → stems
   (vocals, drums, bass, guitar, piano, other). [STARTING HERE]
2. **Note/pitch detection per stem** — match tool to stem:
   - bass/vocals (monophonic) → CREPE or pYIN
   - piano/guitar/other (polyphonic) → Basic Pitch (freq-constrained per stem)
   - drums → onset/rhythm, separate problem (defer)
3. **Tempo/beat + quantization** — librosa or madmom; quantize onsets to grid.
4. **Key detection + transposition** — Krumhansl-Schmuckler / librosa / Essentia;
   transpose via integer pitch shift.
5. **Notation** — music21 (MIDI → MusicXML, transposition) → MuseScore/LilyPond/Verovio (render).

## Accuracy strategy (in build order)
- Level 0: dumb end-to-end pipeline that renders SOMETHING.
- Eval harness with mir_eval (note-level P/R/F1, onset tolerance) BEFORE optimizing.
- Level 1: per-stem frequency constraints in Basic Pitch (free accuracy).
- Level 2: fine-tune Basic Pitch on Slakh2100 (stems + ground-truth MIDI) / MAESTRO (piano).
- Level 3: train a refinement model: input = Basic Pitch posteriorgrams + audio features,
  target = ground-truth MIDI. Denoising framing on top of a strong prior.

## Datasets
- MAESTRO (piano, aligned audio+MIDI — clean, debug the chain here first)
- Slakh2100 (synth multi-instrument WITH stems + MIDI — ideal for stem approach)
- GuitarSet, MedleyDB, MusicNet, URMP

## Key tools
demucs, basic-pitch, music21, librosa, madmom, mir_eval, MuseScore (CLI render)

## Notes / gotchas
- Spotify API only gives metadata + 30s previews, NOT full audio. Use local files.
- Start with piano-only (MAESTRO) to validate the full chain w/o separation error.
- Build the eval harness early — can't improve accuracy you can't measure.

## Current status
Stage 1 (Demucs separation) — building the baseline pipeline script.
