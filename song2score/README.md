# song2score

Transcribe a song (audio file) into sheet music, in any user-chosen key.

See [CLAUDE.md](CLAUDE.md) for the full pipeline design. This README covers
what you need installed to run the code that exists **today**: Stage 1,
source separation ([separate.py](separate.py)).

## Requirements

- Python 3.11
- [ffmpeg](https://ffmpeg.org/download.html) — required by Demucs/torchaudio
  to decode mp3/other compressed audio formats. Install via:
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
- ~1–2 GB free disk space (PyTorch + Demucs model weights)
- Optional: an NVIDIA GPU with CUDA for faster separation (CPU works fine,
  just slower). Apple Silicon users get partial acceleration via MPS
  automatically through PyTorch.

## Setup

```bash
python3.11 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

The core dependency for Stage 1 is [`demucs`](https://github.com/facebookresearch/demucs),
which pulls in PyTorch/torchaudio as transitive dependencies. The first run
of `separate.py` will also download the Demucs model weights (hundreds of MB)
to a local cache — be patient and make sure you have network access.

`requirements.txt` is a full pinned snapshot of the development environment,
so it also includes libraries for pipeline stages that are planned but not
yet implemented (`basic-pitch`, `music21`, `librosa`, `mir_eval`,
`pretty_midi`, etc. — see [CLAUDE.md](CLAUDE.md)). They aren't required to
run `separate.py`, but installing them now means you won't need to revisit
setup as later stages land.

## Usage

```bash
python separate.py path/to/song.mp3
python separate.py path/to/song.mp3 --model htdemucs_6s --out stems/
```

Output stems are written to `<out>/<model>/<track_name>/*.wav`.

## Notes

- `htdemucs_6s` (the default model) splits audio into 6 stems: vocals,
  drums, bass, guitar, piano, other.
- This project intentionally separates stems before transcription —
  transcribing a dense full mix directly is the main source of accuracy
  loss in most audio-to-sheet-music tools.
