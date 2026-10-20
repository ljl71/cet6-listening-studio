"""Independent acoustic review. Produces evidence only, never marks a paper reviewed.

Uses the official TorchAudio 2.8 Wav2Vec2 ASR base 960h acoustic model and
CTC alignment. Original English scripts remain the reference; model output is
not substituted for them. Untranscribed introductions/question numbers are
handled by explicit wildcard states, not by equal-duration estimates.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import unicodedata
import warnings
import wave

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("TORCH_HOME", str(ROOT / "runtime" / "torch-cache"))
import numpy as np
import torch
import torchaudio
import torchaudio.functional as F

warnings.filterwarnings("ignore", category=UserWarning, module="torchaudio")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def number_words(value):
    small = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
    tens = "zero ten twenty thirty forty fifty sixty seventy eighty ninety".split()
    n = int(value)
    if n < 20:
        return [small[n]]
    if n < 100:
        return [tens[n // 10]] + (number_words(n % 10) if n % 10 else [])
    if n < 1000:
        return [small[n // 100], "hundred"] + (number_words(n % 100) if n % 100 else [])
    if n < 1000000:
        return number_words(n // 1000) + ["thousand"] + (number_words(n % 1000) if n % 1000 else [])
    return [small[int(c)] for c in str(n)]


def number_reading(value, hint):
    canonical = number_words(value)
    n = int(value)
    variants = [canonical]
    if 1000 <= n < 2100:
        if n % 100 == 0:
            variants.append(number_words(n // 100) + ["hundred"])
        elif n < 2000 or n >= 2010:
            variants.append(number_words(n // 100) + (["oh"] if n % 100 < 10 else []) + number_words(n % 100))
        if 2000 < n < 2010:
            variants.append(["two", "thousand", "and"] + number_words(n % 1000))
    for words in variants:
        if " " + " ".join(words).upper() + " " in " " + hint.upper() + " ":
            return words
    return canonical


def spoken_words(text, hint="", normalizations=None):
    text = re.sub(r"^[WM]:\s*", "", text, flags=re.I)
    text = text.replace("’", "'")
    text = re.sub(r"[\u2010-\u2015\u2026]", " ", text)
    text = re.sub(r"(?<=\d),(?=\d)", "", text)
    text = text.replace("%", " percent ")
    def article_hundred(match):
        if normalizations is not None:
            normalizations.append({"type": "numeric-spoken-rendering-normalization", "kind": "article-a-hundred-reading", "source": match.group(0), "spoken": "a hundred", "basis": "Equal-valued A HUNDRED phrase observed in independent greedy ASR."})
        return "a hundred"
    if " A HUNDRED " in " " + hint.upper() + " ":
        text = re.sub(r"\ba\s+100(?=[-\s]|$)", article_hundred, text, flags=re.I)
    def mph_rendering(match):
        if normalizations is not None:
            normalizations.append({"type": "abbreviation-spoken-rendering-normalization", "source": match.group(0), "spoken": "miles per hour", "expansionCount": 1})
        return " miles per hour "
    text = re.sub(r"(?<![A-Za-z])mph\s*\(\s*miles\s+per\s+hour\s*\)", mph_rendering, text, flags=re.I)
    text = re.sub(r"(?<![A-Za-z])mph(?![A-Za-z])", mph_rendering, text, flags=re.I)
    for symbol, unit in [("$", "dollars"), ("£", "pounds"), ("€", "euros")]:
        text = re.sub(re.escape(symbol) + r"\s*(\d+(?:\.\d+)?)(\s+(?:million|billion|thousand))?", r"\1\2 " + unit, text, flags=re.I)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    substitutions = {"MR": "MISTER", "MRS": "MISSUS", "MS": "MISS", "DR": "DOCTOR", "PROF": "PROFESSOR", "OK": "OKAY"}
    result = []
    for part in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?", text):
        if part[0].isdigit():
            integer, *decimal = part.split(".")
            expansion = number_reading(integer, hint)
            if decimal:
                expansion += ["point"] + [number_words(d)[0] for d in decimal[0]]
            result.extend(w.upper() for w in expansion)
        else:
            result.append(substitutions.get(part.upper(), part.upper()))
    return result


def wav_samples(path):
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
            raise ValueError(f"Expected 16kHz mono PCM16: {path}")
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


def media_samples(ffmpeg, media, start, end):
    result = subprocess.run([
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", str(start),
        "-i", str(media), "-t", str(end-start), "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1",
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return np.frombuffer(result.stdout, dtype="<i2").astype(np.float32) / 32768.0


def emissions_for(model, samples, cache_file):
    audio_hash = hashlib.sha256(samples.tobytes()).hexdigest()
    if cache_file.exists():
        try:
            with np.load(cache_file) as cached:
                if str(cached["audio_hash"]) == audio_hash:
                    return torch.from_numpy(cached["emissions"].astype(np.float32)), audio_hash, True
        except (ValueError, OSError):
            pass  # Interrupted evidence cache: recompute from the same WAV.
    # 20-second central chunks with 1 second of context on either side. All
    # chunk boundaries lie on the model's 320-sample/20ms frame grid.
    blocks = []
    for central in range(0, len(samples), 320000):
        lo = max(0, central - 16000)
        hi = min(len(samples), central + 320000 + 16000)
        waveform = torch.from_numpy(samples[lo:hi].copy()).unsqueeze(0)
        with torch.inference_mode():
            output, _ = model(waveform)
        begin = (central - lo) // 320
        end = min(begin + 1000, output.shape[1])
        blocks.append(output[0, begin:end].log_softmax(-1).cpu())
    result = torch.cat(blocks, dim=0)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_file.with_suffix(".tmp.npz")
    np.savez_compressed(temporary, emissions=result.numpy().astype(np.float16), audio_hash=audio_hash)
    temporary.replace(cache_file)
    return result, audio_hash, False


def align_passage(paper, passage, emissions, labels):
    dictionary = {label: index for index, label in enumerate(labels)}
    wildcard = len(labels)
    greedy = torch.unique_consecutive(emissions.argmax(-1)).tolist()
    greedy_text = "".join(labels[token] for token in greedy if token != 0).replace("|", " ")
    # A wildcard represents text omitted from the reference (e.g. a question
    # number) AND its pauses. Giving it a constant neutral log-score avoids
    # stealing a final vowel just to force the wildcard onto voiced frames.
    star = torch.zeros_like(emissions[:, :1])
    emission = torch.cat([emissions, star], dim=-1)
    # Forced alignment requires every target state, including the initial
    # wildcard, to occupy a frame. Synthetic blank frames let it do so without
    # consuming an audible first/last letter at the clip boundary.
    padding = torch.full((1, emission.shape[-1]), -10000.0)
    padding[0, 0] = 0.0
    padding[0, wildcard] = 0.0
    emission = torch.cat([padding, emission, padding], dim=0).unsqueeze(0)
    tokens = []
    descriptors = []
    words = []
    normalization_by_sentence = {}

    def append_star():
        tokens.append(wildcard)
        descriptors.append(None)

    def append_words(text, sentence_id=None):
        normalization_notes = []
        normalized_words = spoken_words(text, greedy_text, normalization_notes)
        if sentence_id and normalization_notes:
            normalization_by_sentence[sentence_id] = normalization_notes
        for word in normalized_words:
            if not word or any(character not in dictionary for character in word):
                continue
            if tokens and tokens[-1] != wildcard:
                tokens.append(dictionary["|"])
                descriptors.append(None)
            word_index = len(words)
            words.append({"text": word, "sentenceId": sentence_id, "characterIndices": []})
            for character in word:
                words[-1]["characterIndices"].append(len(tokens))
                tokens.append(dictionary[character])
                descriptors.append(word_index)

    append_star()
    for sentence in passage["sentences"]:
        append_words(sentence["text"], sentence["id"])
    # Spoken questions must participate in the alignment, otherwise a common
    # last word can drift into a following question and inflate confidence.
    for question in paper["questions"]:
        if question["passageId"] == passage["id"] and question.get("prompt"):
            append_star()
            append_words(question["prompt"])
    append_star()
    targets = torch.tensor([tokens], dtype=torch.int32)
    with torch.inference_mode():
        alignment, scores = F.forced_align(emission, targets, blank=0)
    spans = F.merge_tokens(alignment[0], scores[0].exp(), blank=0)
    if len(spans) != len(tokens) or any(span.token != token for span, token in zip(spans, tokens)):
        raise ValueError("Alignment did not preserve the target sequence")
    offset = passage["start"]
    for word in words:
        items = [spans[index] for index in word.pop("characterIndices")]
        word["start"] = round(offset + (items[0].start - 1) * 0.02, 3)
        word["end"] = round(offset + (items[-1].end - 1) * 0.02 + 0.005, 3)
        word["score"] = round(sum(item.score * (item.end - item.start) for item in items) / max(1, sum(item.end - item.start for item in items)), 5)
    sentences = []
    for source in passage["sentences"]:
        items = [word for word in words if word["sentenceId"] == source["id"]]
        if not items:
            sentences.append({"id": source["id"], "error": "No recognized alphabetic reference tokens"})
            continue
        start, end = items[0]["start"], items[-1]["end"]
        sentences.append({
            "id": source["id"], "text": source["text"], "acousticStart": start, "acousticEnd": end,
            "existingStart": source["start"], "existingEnd": source["end"],
            "startDifference": round(start - source["start"], 3) if source["end"] > source["start"] else None,
            "endDifference": round(end - source["end"], 3) if source["end"] > source["start"] else None,
            "firstWordScore": items[0]["score"], "lastWordScore": items[-1]["score"],
            "meanWordScore": round(sum(word["score"] for word in items) / len(items), 5),
            "minimumWordScore": min(word["score"] for word in items),
            "maxWordGap": round(max([right["start"]-left["end"] for left,right in zip(items,items[1:])] or [0]), 3),
            "words": items, "reviewed": False,
            "lexicalNormalizations": normalization_by_sentence.get(source["id"], []),
        })
    return sentences, greedy_text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--paper")
    parser.add_argument("--passage", type=int)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--priority-report", default="data/references/alignment-guard-comparison.json")
    parser.add_argument("--cached-only", action="store_true")
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = None if args.cached_only else bundle.get_model().eval()
    labels = bundle.get_labels()
    assets = read_json(ROOT / "data" / "assets.json")
    ffmpeg = read_json(ROOT / "runtime" / "media-tools.json")["ffmpeg"]
    checked_assets = set()
    completed = 0
    priorities = {}
    priority_file = ROOT / args.priority_report
    if priority_file.exists():
        priority = read_json(priority_file)
        for item in priority.get("changes", []):
            priorities[item["passageId"]] = max(priorities.get(item["passageId"], 0), 1)
        for item in priority.get("risks", []) + priority.get("missing", []):
            priorities[item["passageId"]] = 2
    jobs = []
    for file in sorted((ROOT / "data" / "papers").glob("*.json")):
        if args.paper and file.stem != args.paper:
            continue
        paper = read_json(file)
        for passage in paper["passages"]:
            if args.passage and passage["order"] != args.passage:
                continue
            jobs.append((file, passage["order"], priorities.get(passage["id"], 0)))
    jobs.sort(key=lambda job: (-job[2], str(job[0]), job[1]))
    for file, passage_order, _ in jobs:
            paper = read_json(file)
            passage = next(p for p in paper["passages"] if p["order"] == passage_order)
            started = time.time()
            folder = ROOT / "data" / "acoustic-review" / paper["id"]
            if args.cached_only and not (folder / f"passage-{passage['order']}.npz").exists():
                continue
            asset = assets[paper["audioAssetId"]]
            media = (ROOT / "data" / asset["path"]).resolve()
            if not media.is_relative_to((ROOT / "data").resolve()):
                raise ValueError("Media file leaves the data directory")
            if paper["audioAssetId"] not in checked_assets:
                if hashlib.sha256(media.read_bytes()).hexdigest() != asset["sha256"]:
                    raise ValueError("Source media checksum mismatch")
                checked_assets.add(paper["audioAssetId"])
            samples = media_samples(ffmpeg, media, passage["start"], passage["end"])
            emissions, digest, cached = emissions_for(model, samples, folder / f"passage-{passage['order']}.npz")
            sentences, greedy = align_passage(paper, passage, emissions, labels)
            report = {
                "paperId": paper["id"], "passageId": passage["id"], "audioAssetId": paper["audioAssetId"],
                "pcmSha256": digest, "method": "independent-wav2vec2-ctc-alignment-with-question-context",
                "mediaSha256": asset["sha256"], "sourceRange": {"start": passage["start"], "end": passage["end"]},
                "decode": "Fresh FFmpeg decode of the verified original media, mono PCM16 at 16000Hz; no inherited WAV timing assumption.",
                "torch": torch.__version__, "torchaudio": torchaudio.__version__,
                "model": "WAV2VEC2_ASR_BASE_960H", "frameSeconds": 0.02,
                "lexicalNormalizationVersion": 3,
                "referenceSha256": hashlib.sha256(json.dumps(passage["sentences"], sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
                "referenceTextSha256": hashlib.sha256("\n".join(sentence["id"]+"\t"+sentence["text"] for sentence in passage["sentences"]).encode()).hexdigest(),
                "reviewed": False, "greedyTranscript": greedy, "sentences": sentences,
            }
            write_json(folder / f"passage-{passage['order']}.json", report)
            print(json.dumps({"paper": paper["id"], "passage": passage["order"], "sentences": len(sentences), "seconds": round(time.time()-started, 1), "cached": cached}, ensure_ascii=False), flush=True)
            completed += 1
            if args.limit and completed >= args.limit:
                return


if __name__ == "__main__":
    main()
