#!/usr/bin/env python3
"""Build the videos of the two-part evaluation study (eval/).

    python3 eval/make_eval_videos.py --compare <folder> --recon <folder> --names X,Y

Part 1 (compare): for every clip in compare_clips.txt, the source video in --compare has
several panels side by side. Three are kept: the real signer and the two systems being
compared (their positions are in LAYOUT). Each clip is written twice, once with each
system in the middle, as GT | X | Y and GT | Y | X (listed in that order in videos.js),
and the page deals them out so every rater sees each arrangement on half the clips.
The files get neutral names (c01-<hash>.mp4); which system sits where is
written only to mapping.csv, which is git-ignored: paste it into the Google Sheet's
Mapping tab. --names gives the two systems' names for mapping.csv, in LAYOUT order.

Part 2 (recon): every clip in recon_clips.txt is a GT Video | GT Mesh video in --recon,
copied under its own name, so its answers line up with the GT Mesh study's (mesh/).

All panels lose their burned-in labels (the top LABEL_ROWS rows; the page draws its own)
and the subtitle along the bottom (the page shows the sentence from subtitles.tsv).
Then videos.js is rewritten, and videos/ keeps only the files listed in it.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIDEO_DIR = HERE / "videos"
COMPARE_LIST = HERE / "compare_clips.txt"
RECON_LIST = HERE / "recon_clips.txt"
SUBTITLES = HERE / "subtitles.tsv"
VIDEOS_JS = HERE / "videos.js"
MAPPING = HERE / "mapping.csv"

# Panel positions (0 = leftmost) in the compare sources, by the number of square panels
# side by side: (real signer, system X, system Y).
LAYOUT = {6: (0, 5, 3), 5: (0, 4, 2)}
LABEL_ROWS = 36     # the burned-in panel labels sit above this row
KEEP_ROWS = 416     # rows kept below them; the subtitle starts at row 456


def read_list(path):
    names = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.append(line.split()[0])
    return names


def read_sentences():
    out = {}
    for line in SUBTITLES.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            name, _, sentence = line.partition("\t")
            out[name.strip()] = sentence.strip()
    return out


def size(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True).stdout
    w, h = out.strip().split(",")[:2]
    return int(w), int(h)


def encode(src, graph, dst):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-filter_complex", graph, "-map", "[v]",
         "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", str(dst)],
        check=True)


def panel(i, side, tag):
    return f"[0:v]crop={side}:{KEEP_ROWS}:{i * side}:{LABEL_ROWS}[{tag}]"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--compare", required=True, type=Path, help="folder with the multi-panel comparison videos")
    ap.add_argument("--recon", required=True, type=Path, help="folder with the GT Video | GT Mesh videos")
    ap.add_argument("--names", required=True, help="names of system X and system Y, e.g. X,Y (only go to mapping.csv)")
    args = ap.parse_args()
    names = [n.strip() for n in args.names.split(",")]
    if len(names) != 2 or not all(names):
        sys.exit("--names needs two names separated by a comma.")
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        sys.exit("This script needs ffmpeg (and ffprobe).")

    sentences = read_sentences()
    VIDEO_DIR.mkdir(exist_ok=True)
    keep = set()
    compare, recon, mapping = [], [], []

    with tempfile.TemporaryDirectory() as tmp:
        for n, clip in enumerate(read_list(COMPARE_LIST), 1):
            src = args.compare.expanduser() / clip
            if not src.exists():
                sys.exit(f"Missing {src}")
            w, h = size(src)
            layout = LAYOUT.get(round(w / h))
            if not layout:
                sys.exit(f"{clip}: don't know its panels ({w}x{h}).")
            real, x, y = layout
            versions = []
            for middle, right in ((x, y), (y, x)):
                graph = ";".join([panel(real, h, "g"), panel(middle, h, "a"), panel(right, h, "b"),
                                  "[g][a][b]hstack=inputs=3[v]"])
                out = Path(tmp) / "out.mp4"
                encode(src, graph, out)
                digest = hashlib.md5(out.read_bytes()).hexdigest()[:8]
                vid = f"c{n:02d}-{digest}.mp4"
                shutil.move(out, VIDEO_DIR / vid)
                keep.add(vid)
                a, b = (names[0], names[1]) if middle == x else (names[1], names[0])
                mapping.append((vid, a, b, clip))
                versions.append(vid)
            # Always X-in-the-middle first: the page deals out the versions in turn, so this
            # order is what gives every rater each arrangement equally often.
            compare.append({"clip": f"c{n:02d}", "sentence": sentences.get(clip, ""), "versions": versions})
            print(f"  c{n:02d}  {clip}")

        for clip in read_list(RECON_LIST):
            src = args.recon.expanduser() / clip
            if not src.exists():
                sys.exit(f"Missing {src}")
            w, h = size(src)
            graph = f"[0:v]crop={w}:{KEEP_ROWS}:0:{LABEL_ROWS}[v]"
            encode(src, graph, VIDEO_DIR / clip)
            keep.add(clip)
            recon.append({"id": clip, "sentence": sentences.get(clip, "")})
            print(f"  recon {clip}")

    for f in VIDEO_DIR.glob("*.mp4"):
        if f.name not in keep:
            f.unlink()

    missing = [c["clip"] for c in compare if not c["sentence"]] + [r["id"] for r in recon if not r["sentence"]]
    if missing:
        print("No sentence in subtitles.tsv for: " + ", ".join(missing))

    lines = ["// Generated by make_eval_videos.py. Part 1: each clip has two versions (the two avatars",
             "// in either order); the page shows each rater one of them. Part 2: GT Video | GT Mesh clips.",
             "window.STUDY_VIDEOS = {", '  "compare": [']
    lines += [f"    {json.dumps(c, ensure_ascii=False)}," for c in compare]
    lines += ["  ],", '  "recon": [']
    lines += [f"    {json.dumps(r, ensure_ascii=False)}," for r in recon]
    lines += ["  ],", "};", ""]
    VIDEOS_JS.write_text("\n".join(lines), encoding="utf-8")

    rows = ["video_id,A,B,clip"] + [",".join(r) for r in mapping]
    MAPPING.write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"\nWrote {len(compare)} compare clips ({len(mapping)} files), {len(recon)} recon clips, "
          f"{VIDEOS_JS.name} and {MAPPING.name} (private: paste it into the Sheet's Mapping tab).")


if __name__ == "__main__":
    main()
