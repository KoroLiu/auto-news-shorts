# -*- coding: utf-8 -*-
"""Qwen3-TTS helper: clone a voice pack (sample.wav + refText) and read each sentence, with auto quality checks.

Usage (in the qwen3-tts conda env): python tts_qwen3.py job.json
job.json = {"model": "<model folder or Hugging Face id, e.g. Qwen/Qwen3-TTS-12Hz-1.7B-Base>", "ref": "...sample.wav", "refText": "...",
            "pause": 0.22, "minSim": 0.975, "tries": 3, "seed": 42,
            "items": [{"id": "s1", "out": "path/s1.wav", "sentences": ["第一句。", "第二句。"]}]}
Writes <out> (24k mono wav) and <out>.json (one timing entry per sentence) for each item.
Quality checks per sentence: voice similarity to the sample (speaker embedding) and a sane duration
for the text length; a sentence that fails is re-read with another seed, keeping the best attempt.
"""
import json
import re
import sys
import time

import numpy as np
import soundfile as sf
import torch
import librosa
from qwen_tts import Qwen3TTSModel

SR_SPK = 24000


def units(text):
    """Rough speaking length: CJK char = 1, each latin word / number ≈ 1.2."""
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    lat = len(re.findall(r"[A-Za-z]+|\d+(?:\.\d+)*", text))
    return cjk + 1.2 * lat


def trim(wav, sr):
    y, _ = librosa.effects.trim(wav, top_db=40, frame_length=1024, hop_length=256)
    pad = np.zeros(int(sr * 0.05), dtype=np.float32)
    return np.concatenate([pad, y.astype(np.float32), pad])


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # run with -I, which ignores PYTHONIOENCODING
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        job = json.load(f)
    model = Qwen3TTSModel.from_pretrained(job["model"], device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
    prompt = model.create_voice_clone_prompt(ref_audio=job["ref"], ref_text=job["refText"], x_vector_only_mode=False)
    ref_emb = torch.nn.functional.normalize(prompt[0].ref_spk_embedding.float().flatten(), dim=0)

    def similarity(wav, sr):
        y = librosa.resample(y=wav.astype(np.float32), orig_sr=sr, target_sr=SR_SPK) if sr != SR_SPK else wav.astype(np.float32)
        emb = model.model.extract_speaker_embedding(audio=y, sr=SR_SPK)
        return float(torch.nn.functional.normalize(emb.float().flatten(), dim=0) @ ref_emb.to(emb.device))

    # Qwen3 speaker-encoder cosine: same voice ≈0.99, drifted take ≈0.96, other designed voices ≈0.97
    min_sim, tries, seed0 = job.get("minSim", 0.975), job.get("tries", 3), job.get("seed", 42)
    pause = job.get("pause", 0.22)
    n_total = sum(len(it["sentences"]) for it in job["items"])
    done, retried, t_start = 0, 0, time.time()
    for it in job["items"]:
        parts, words, t, sr_out = [], [], 0.0, None
        reseed = it.get("reseed") or {}  # 工作台「这句重念」：换一个随机种子再念
        for k, text in enumerate(it["sentences"]):
            expect = units(text) / 4.6
            best = None
            for a in range(tries):
                torch.manual_seed(seed0 + 1000 * a + k + 100003 * int(reseed.get(str(k), 0)))
                wavs, sr = model.generate_voice_clone(text=text, language="Chinese", voice_clone_prompt=prompt)
                y = trim(np.asarray(wavs[0], dtype=np.float32), sr)
                dur = len(y) / sr
                sim = similarity(y, sr) if dur > 1.5 else 1.0  # very short takes give noisy embeddings
                dur_ok = expect * 0.4 - 0.3 <= dur <= expect * 2.0 + 1.5
                score = sim - (0 if dur_ok else 1)
                if best is None or score > best[0]:
                    best = (score, y, sr, sim, dur_ok)
                if sim >= min_sim and dur_ok:
                    break
                retried += 1
                print("RETRY %s#%d 声纹%.2f 时长%.1fs(预计%.1fs)" % (it["id"], k, sim, dur, expect), flush=True)
            _, y, sr, sim, dur_ok = best
            if not (sim >= min_sim and dur_ok):
                print("WARN %s#%d 重试后仍不理想：声纹%.2f 时长%.1fs" % (it["id"], k, sim, len(y) / sr), flush=True)
            sr_out = sr_out or sr
            if sr != sr_out:
                y = librosa.resample(y=y, orig_sr=sr, target_sr=sr_out)
            dur = len(y) / sr_out
            words.append({"t0": t, "t1": t + dur, "text": text, "kind": "WordBoundary"})
            parts.append(y)
            gap = np.zeros(int(sr_out * pause), dtype=np.float32)
            parts.append(gap)
            t += dur + len(gap) / sr_out
            done += 1
        audio = np.concatenate(parts) if parts else np.zeros(int((sr_out or 24000) * 0.3), dtype=np.float32)
        sf.write(it["out"], audio, sr_out or 24000, subtype="PCM_16")
        with open(it["out"] + ".json", "w", encoding="utf-8") as f:
            json.dump({"id": it["id"], "words": words}, f, ensure_ascii=False)
        el = time.time() - t_start
        print("OK %s  进度 %d/%d 句，已用 %d 分钟" % (it["id"], done, n_total, el // 60), flush=True)
    print("DONE 共 %d 句，重念 %d 次，用时 %.1f 分钟" % (n_total, retried, (time.time() - t_start) / 60), flush=True)


if __name__ == "__main__":
    main()
