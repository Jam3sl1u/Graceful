"""
Stage 1: Source separation with Demucs.

Splits a song into stems (vocals, drums, bass, + melodic parts) so that later
stages can transcribe each part independently. Separating before transcription
is the biggest single accuracy lever for dense songs.

Usage:
    python separate.py path/to/song.mp3
    python separate.py path/to/song.mp3 --model htdemucs_6s --out stems/
"""

import argparse
import subprocess
import sys
from pathlib import Path


# htdemucs    -> 4 stems: vocals, drums, bass, other
# htdemucs_6s -> 6 stems: vocals, drums, bass, guitar, piano, other
#   (6s is better for our use case: it isolates piano + guitar, which we want
#    to transcribe separately. "other" catches whatever's left.)
DEFAULT_MODEL = "htdemucs_6s"


def separate(audio_path: Path, model: str, out_dir: Path) -> Path:
    """Run Demucs on one file. Returns the folder containing the stem WAVs."""
    if not audio_path.exists():
        sys.exit(f"File not found: {audio_path}")

    out_dir.mkdir(parents=True, exist_ok=True)

    # We shell out to the demucs CLI rather than import its API — it's the
    # stable, documented interface and handles model download/caching for us.
    cmd = [
        sys.executable, "-m", "demucs",
        "-n", model,
        "--out", str(out_dir),
        # "--mp3",            # uncomment to write mp3 stems instead of wav
        # "--device", "cuda", # demucs auto-detects GPU; force here if needed
        str(audio_path),
    ]

    print(f"[separate] model={model}")
    print(f"[separate] input={audio_path}")
    print(f"[separate] running: {' '.join(cmd)}\n")

    # First run downloads the model weights (~hundreds of MB). Be patient.
    subprocess.run(cmd, check=True)

    # Demucs writes to: <out_dir>/<model>/<track_name>/<stem>.wav
    track_name = audio_path.stem
    stems_dir = out_dir / model / track_name

    print(f"\n[separate] stems written to: {stems_dir}")
    for stem in sorted(stems_dir.glob("*.wav")):
        print(f"    - {stem.name}")

    return stems_dir


def main():
    p = argparse.ArgumentParser(description="Stage 1: separate a song into stems.")
    p.add_argument("audio", type=Path, help="path to input audio (mp3/wav/flac)")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help=f"demucs model (default: {DEFAULT_MODEL})")
    p.add_argument("--out", type=Path, default=Path("stems"),
                   help="output directory (default: stems/)")
    args = p.parse_args()

    stems_dir = separate(args.audio, args.model, args.out)

    print("\n[separate] done. Next stage will transcribe each stem:")
    print("    bass/vocals  -> CREPE or pYIN (monophonic)")
    print("    piano/guitar/other -> Basic Pitch (frequency-constrained)")
    print(f"    stems_dir = {stems_dir}")


if __name__ == "__main__":
    main()
