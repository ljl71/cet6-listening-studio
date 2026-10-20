"""Inspect original media before each inherited passage boundary; evidence only."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("acoustic_review", ROOT / "scripts/acoustic-review.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--paper")
    parser.add_argument("--cached-only", action="store_true")
    args = parser.parse_args()
    review.torch.set_num_threads(args.threads)
    bundle = review.torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = None if args.cached_only else bundle.get_model().eval()
    labels = bundle.get_labels()
    assets = review.read_json(ROOT / "data/assets.json")
    ffmpeg = review.read_json(ROOT / "runtime/media-tools.json")["ffmpeg"]
    checked = set()
    count = 0
    for file in sorted((ROOT / "data/papers").glob("*.json")):
        if args.paper and file.stem != args.paper:
            continue
        paper = review.read_json(file)
        asset = assets[paper["audioAssetId"]]
        media = (ROOT / "data" / asset["path"]).resolve()
        if not media.is_relative_to((ROOT / "data").resolve()):
            raise ValueError("Media outside data folder")
        if paper["audioAssetId"] not in checked:
            if hashlib.sha256(media.read_bytes()).hexdigest() != asset["sha256"]:
                raise ValueError("Media checksum mismatch")
            checked.add(paper["audioAssetId"])
        for passage in paper["passages"]:
            begun = time.time()
            sentence = passage["sentences"][0]
            # Twelve words are enough to identify the opening rather than a
            # common first word; the rest of the clip is explicitly unlabelled.
            begin = max(0, passage["start"] - 2)
            end = min(paper["duration"], passage["end"], passage["start"] + 14)
            folder = ROOT / "data/opening-review" / paper["id"]
            cache = folder / f"passage-{passage['order']}.npz"
            if args.cached_only and not cache.exists():
                continue
            samples = review.media_samples(ffmpeg, media, begin, end)
            emissions, pcm_hash, cached = review.emissions_for(model, samples, cache)
            token_ids = review.torch.unique_consecutive(emissions.argmax(-1)).tolist()
            independent_greedy = "".join(labels[token] for token in token_ids if token != 0).replace("|", " ")
            # Preserve equal-valued spoken year/hundred readings, using the
            # independent transcript as evidence rather than forcing extra words.
            words = review.spoken_words(sentence["text"], independent_greedy)[:12]
            clipped_passage = {"id": passage["id"], "start": begin, "end": end,
                "sentences": [{"id": sentence["id"], "text": " ".join(words), "start": sentence["start"], "end": sentence["end"]}]}
            aligned, greedy = review.align_passage({"questions": []}, clipped_passage, emissions, labels)
            result = {"schemaVersion": 2, "paperId": paper["id"], "passageId": passage["id"],
                "passageOrder": passage["order"], "sentenceId": sentence["id"], "originalText": sentence["text"],
                "referenceTextSha256": hashlib.sha256(sentence["text"].encode()).hexdigest(),
                "audioAssetId": paper["audioAssetId"], "mediaSha256": asset["sha256"], "pcmSha256": pcm_hash,
                "sourceRange": {"start": begin, "end": end}, "originalPassageRange": {"start": passage["start"], "end": passage["end"]},
                "referenceOpeningWords": words, "greedyTranscript": greedy, "sentences": aligned,
                "method": "Wav2Vec2 CTC from independently decoded original media with two seconds BEFORE inherited passage start; twelve-word opening plus wildcard context.",
                "model": "WAV2VEC2_ASR_BASE_960H", "torch": review.torch.__version__, "torchaudio": review.torchaudio.__version__,
                "reviewed": False, "limitations": "Candidate acoustic evidence only; does not establish human listening or sentence completion. Source excerpt spelling remains unchanged."}
            if aligned and aligned[0]["words"]:
                first = aligned[0]["words"][0]
                result["firstWordStartDifference"] = round(first["start"] - passage["start"], 3)
                result["firstWordScore"] = first["score"]
            review.write_json(folder / f"passage-{passage['order']}.json", result)
            print(json.dumps({"paper": paper["id"], "passage": passage["order"], "delta": result.get("firstWordStartDifference"), "score": result.get("firstWordScore"), "seconds": round(time.time()-begun, 1), "cached": cached}), flush=True)
            count += 1
            if args.limit and count >= args.limit:
                return


if __name__ == "__main__":
    main()
