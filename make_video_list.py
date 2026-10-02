#!/usr/bin/env python3
"""Scan videos/ and write videos.js, the list of rounds the study shows.

Put each method's videos in its own folder, using the same file names in every folder:

    videos/
      ours/        001.mp4  002.mp4  ...
      baseline1/   001.mp4  002.mp4  ...
      baseline2/   001.mp4  002.mp4  ...
      baseline3/   001.mp4  002.mp4  ...

Files with the same name (ignoring the extension) are versions of the same sample and are
shown side by side in one round. Sample ids may include subfolders:
videos/ours/speakerA/001.mp4 is sample "speakerA/001".

Run it again whenever you add, remove or rename videos:

    python3 make_video_list.py
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
VIDEO_DIR = ROOT / "videos"
OUT = ROOT / "videos.js"

EXTENSIONS = {".mp4", ".m4v", ".webm", ".mov", ".ogv"}
# Codecs that play in current Chrome, Firefox, Safari and Edge.
WEB_CODECS = {"h264", "vp8", "vp9", "av1"}
GITHUB_FILE_LIMIT = 100 * 1024 * 1024    # GitHub rejects files larger than this
GITHUB_FILE_WARN = 50 * 1024 * 1024
PAGES_SITE_LIMIT = 1024 * 1024 * 1024    # GitHub Pages sites should stay under 1 GB
# Same rules as the Apps Script: ids can't start with = + - @ (formula injection)
# and method names can't contain "|" (used to join them in the sheet).
METHOD_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$")
SAMPLE_RE = re.compile(r"^[A-Za-z0-9_][^\x00-\x1f\x7f|]{0,199}$")


def probe(path):
    """Return (codec, duration_seconds) using ffprobe, or (None, None) if unavailable."""
    if not shutil.which("ffprobe"):
        return None, None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        info = json.loads(out.stdout or "{}")
        streams = info.get("streams") or [{}]
        duration = info.get("format", {}).get("duration")
        return streams[0].get("codec_name"), float(duration) if duration else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None, None


def main():
    if not VIDEO_DIR.is_dir():
        VIDEO_DIR.mkdir()

    method_dirs = sorted(p for p in VIDEO_DIR.iterdir() if p.is_dir() and not p.name.startswith("."))
    problems = 0
    total = 0
    by_sample = {}   # sample id -> {method: src}
    durations = {}   # sample id -> {method: seconds}
    methods = []

    for mdir in method_dirs:
        method = mdir.name
        if not METHOD_RE.match(method):
            print(f"  SKIP  folder '{method}': use only letters, digits, space, _ . - (no |)")
            problems += 1
            continue
        methods.append(method)
        for path in sorted(mdir.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in EXTENSIONS or path.name.startswith("."):
                continue
            rel = path.relative_to(VIDEO_DIR).as_posix()
            sample = path.relative_to(mdir).with_suffix("").as_posix()
            size = path.stat().st_size
            total += size
            mb = size / 1024 / 1024

            if not SAMPLE_RE.match(sample):
                print(f"  SKIP  {rel}: rename it so it starts with a letter, digit or _ (and has no |)")
                problems += 1
                continue
            if method in by_sample.get(sample, {}):
                print(f"  ERROR {rel}: '{method}' has two files for sample '{sample}'")
                problems += 1
                continue
            if size > GITHUB_FILE_LIMIT:
                print(f"  ERROR {rel}: {mb:.0f} MB — GitHub rejects files over 100 MB")
                problems += 1
            elif size > GITHUB_FILE_WARN:
                print(f"  warn  {rel}: {mb:.0f} MB — large files load slowly for raters")

            codec, seconds = probe(path)
            if codec == "hevc":
                print(f"  warn  {rel}: H.265/HEVC plays in Safari but not in most Chrome/Firefox setups")
            elif codec and codec not in WEB_CODECS:
                print(f"  ERROR {rel}: codec '{codec}' won't play in browsers (use H.264, VP9 or AV1)")
                problems += 1

            by_sample.setdefault(sample, {})[method] = "videos/" + quote(rel)
            if seconds:
                durations.setdefault(sample, {})[method] = seconds

    loose = [p.name for p in VIDEO_DIR.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS]
    if loose:
        print(f"  warn  {len(loose)} video(s) directly in videos/ were ignored; put them in a method folder")

    if len(methods) < 2:
        print("  ERROR need at least two method folders inside videos/ (e.g. videos/ours, videos/baseline1)")
        problems += 1

    samples = []
    for sample in sorted(by_sample):
        vids = by_sample[sample]
        missing = [m for m in methods if m not in vids]
        if missing:
            print(f"  SKIP  sample '{sample}': missing in {', '.join(missing)}")
            problems += 1
            continue
        d = durations.get(sample, {})
        if len(d) > 1 and max(d.values()) - min(d.values()) > 0.5:
            spread = ", ".join(f"{m} {s:.1f}s" for m, s in sorted(d.items()))
            print(f"  warn  sample '{sample}': lengths differ ({spread}); the round ends when the longest one does")
        samples.append({"id": sample, "videos": {m: vids[m] for m in methods}})

    lines = ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in samples)
    OUT.write_text(
        "// Generated by make_video_list.py. Re-run it after adding or removing videos.\n"
        f"window.STUDY_METHODS = {json.dumps(methods, ensure_ascii=False)};\n"
        "window.STUDY_SAMPLES = [\n" + (lines + ",\n" if lines else "") + "];\n",
        encoding="utf-8",
    )

    print(f"\nWrote {OUT.name}: {len(methods)} method(s) {methods}, {len(samples)} round(s), "
          f"{total / 1024 / 1024:.1f} MB total.")
    if total > PAGES_SITE_LIMIT:
        print("  warn  over 1 GB in total; GitHub Pages may refuse to publish the site.")
    if not shutil.which("ffprobe"):
        print("  (install ffmpeg to also check codecs and clip lengths)")
    if problems:
        print(f"{problems} problem(s) above need fixing before you publish.")
        sys.exit(1)


if __name__ == "__main__":
    main()
