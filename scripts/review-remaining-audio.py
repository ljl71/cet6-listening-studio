"""Evidence-only review with the official OpenAI Whisper implementation.

The expected transcript is never supplied to the decoder. Papers, quality and
human review flags are never modified. Cached evidence is bound to file hashes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import sys
import wave
import numpy as np
import torch
import whisper

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")

ROOT = Path(__file__).resolve().parent.parent
def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))
def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()
def write(file, value):
    file = Path(file)
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(file)

parser = argparse.ArgumentParser()
parser.add_argument("--limit", type=int, default=9999)
args = parser.parse_args()
location = read(ROOT / "runtime/remaining-review-location.json")
folder = ROOT / location["root"] / "audio"
manifest = read(folder / "windows.json")
assets = read(ROOT / "data/assets.json")
media = read(ROOT / "runtime/media-tools.json")
model_file = ROOT / "runtime/whisper-python-cache/small.en.pt"
model_hash = digest(model_file)
if model_hash != "f953ad0fd29cacd07d5a9eda5624af0f6bcf2258be67c92b79389873d91e0872":
    raise ValueError("Original model SHA256 mismatch")
torch.set_num_threads(4)
model = whisper.load_model(str(model_file), device="cpu")
result = {"method": "Official OpenAI Whisper small.en; independent unprompted original-media crops; word timestamps; no paper mutation or human-listening claim.",
          "modelSha256": model_hash, "expectedTranscriptSupplied": False,
          "implementation": "openai-whisper", "windows": []}
checked = set()
for index, window in enumerate(manifest["windows"][:args.limit]):
    paper = read(ROOT / "data/papers" / (window["paperId"] + ".json"))
    asset = assets[paper["audioAssetId"]]
    source = ROOT / "data" / asset["path"]
    if paper["audioAssetId"] not in checked:
        if digest(source) != asset["sha256"]:
            raise ValueError("Original media SHA256 mismatch")
        checked.add(paper["audioAssetId"])
    start, end = round(window["from"], 3), round(min(window["to"], paper["duration"]), 3)
    stem = folder / f"{index+1:03d}-{paper['id']}"
    wav = stem.with_suffix(".wav")
    output = folder / (stem.name + "-python-small.json")
    meta_file = folder / (stem.name + "-python-small.meta.json")
    identity = {"audioAssetId": paper["audioAssetId"], "mediaSha256": asset["sha256"],
                "sourceRange": {"start": start, "end": end}, "targets": window["targets"],
                "modelSha256": model_hash, "decoder": {"temperature": 0.0, "beamSize": 5, "conditionOnPreviousText": False, "wordTimestamps": True}}
    cached = False
    try:
        old = read(meta_file)
        cached = old["identity"] == identity and digest(wav) == old["wavSha256"] and digest(output) == old["recognitionSha256"]
    except (OSError, KeyError, ValueError):
        pass
    if not cached:
        subprocess.run([media["ffmpeg"], "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(start), "-i", str(source), "-t", str(end-start), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)], check=True)
        with wave.open(str(wav)) as handle:
            audio = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype("float32") / 32768
        began = time.time()
        recognition = model.transcribe(audio, language="en", task="transcribe", fp16=False,
                                      temperature=0.0, beam_size=5, condition_on_previous_text=False,
                                      word_timestamps=True, verbose=False)
        write(output, recognition)
        write(meta_file, {"identity": identity, "wavSha256": digest(wav), "recognitionSha256": digest(output),
                          "elapsedSeconds": round(time.time()-began, 3), "expectedTranscriptSupplied": False,
                          "timeBasis": "All recognition times relative to this independently decoded crop; add sourceRange.start for original audio seconds."})
    recognition = read(output)
    row = {**window, "sourceRange": {"start": start, "end": end}, "pythonRecognition": str(output.relative_to(ROOT)).replace("\\", "/"),
           "pythonMetadata": str(meta_file.relative_to(ROOT)).replace("\\", "/"), "pythonText": recognition["text"], "completed": True}
    result["windows"].append(row)
    result["completed"] = len(result["windows"])
    result["total"] = len(manifest["windows"])
    write(folder / "windows-python.json", result)
    print(json.dumps({"window": index+1, "total": len(manifest["windows"]), "cached": cached, "targets": window["targets"], "text": recognition["text"]}, ensure_ascii=False), flush=True)
