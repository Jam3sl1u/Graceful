"""
Stage 1: Source separation with Demucs.

Splits a song into stems (vocals, drums, bass, + melodic parts) so that later
stages can transcribe each part independently. Separating before transcription
is the biggest single accuracy lever for dense songs.

Usage:
    python separate.py path/to/song.mp3
    python separate.py path/to/song.mp3 --model htdemucs_6s --out stems/
    python separate.py path/to/song.mp3 --device mps
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


def default_device() -> str:
    """Pick the fastest available backend: CUDA > Apple MPS > CPU."""
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def separate(
    audio_path: Path,
    model: str,
    out_dir: Path,
    device: str,
    segment: int | None = None,
) -> Path:
    """Run Demucs on one file. Returns the folder containing the stem WAVs."""
    if not audio_path.exists():
        sys.exit(f"File not found: {audio_path}")

    out_dir.mkdir(parents=True, exist_ok=True)

    # We shell out to the demucs CLI rather than import its API — it's the
    # stable, documented interface and handles model download/caching for us.
    cmd = [
        sys.executable, "-m", "demucs",
        "-d", device,
        "-n", model,
        "--out", str(out_dir),
        # "--mp3",  # uncomment to write mp3 stems instead of wav
        str(audio_path),
    ]
    if segment is not None:
        cmd[-1:-1] = ["--segment", str(segment)]

    print(f"[separate] model={model}")
    print(f"[separate] device={device}")
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
    p.add_argument("--device", default=None,
                   help="compute device: mps, cuda, or cpu (default: auto-detect)")
    p.add_argument("--segment", type=int, default=None,
                   help="chunk size in seconds; lower if you hit GPU OOM (e.g. 8)")
    args = p.parse_args()

    device = args.device or default_device()
    stems_dir = separate(args.audio, args.model, args.out, device, args.segment)

    print("\n[separate] done. Next stage will transcribe each stem:")
    print("    bass/vocals  -> CREPE or pYIN (monophonic)")
    print("    piano/guitar/other -> Basic Pitch (frequency-constrained)")
    print(f"    stems_dir = {stems_dir}")


if __name__ == "__main__":
    main()
