# -*- coding: utf-8 -*-
"""Edge TTS helper: synthesize several texts with word-level timing.

Usage: python tts_edge.py job.json
job.json = {"voice": "zh-CN-XiaoxiaoNeural", "rate": "+5%", "pitch": "+0Hz", "volume": "+0%",
            "concurrency": 4, "items": [{"id": "n1", "text": "...", "out": "path/n1.mp3"}]}
Writes <out> (mp3) and <out>.json (word boundaries in seconds) for each item.
"""
import asyncio
import json
import sys
import os

try:
    import edge_tts
except ImportError:
    print("ERROR: 缺少 edge-tts，请先运行 npm run setup（或 pip install edge-tts）", flush=True)
    sys.exit(3)


async def synth_one(item, cfg, sem):
    async with sem:
        last_err = None
        for attempt in range(4):
            try:
                comm = edge_tts.Communicate(item["text"], cfg.get("voice", "zh-CN-XiaoxiaoNeural"),
                                            rate=cfg.get("rate", "+0%"), pitch=cfg.get("pitch", "+0Hz"),
                                            volume=cfg.get("volume", "+0%"), boundary="WordBoundary")
                audio = bytearray()
                words = []
                async for chunk in comm.stream():
                    if chunk["type"] == "audio":
                        audio.extend(chunk["data"])
                    elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                        words.append({"t0": chunk["offset"] / 1e7, "t1": (chunk["offset"] + chunk["duration"]) / 1e7,
                                      "text": chunk.get("text", ""), "kind": chunk["type"]})
                if len(audio) < 2000:
                    raise RuntimeError("音频为空")
                os.makedirs(os.path.dirname(item["out"]) or ".", exist_ok=True)
                with open(item["out"], "wb") as f:
                    f.write(audio)
                with open(item["out"] + ".json", "w", encoding="utf-8") as f:
                    json.dump({"id": item["id"], "words": words}, f, ensure_ascii=False)
                print("OK " + item["id"], flush=True)
                return True
            except Exception as e:  # network hiccups are common; retry
                last_err = e
                await asyncio.sleep(1.5 * (attempt + 1))
        print("FAIL %s %s" % (item["id"], repr(last_err)), flush=True)
        return False


async def main():
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cfg = json.load(f)
    sem = asyncio.Semaphore(int(cfg.get("concurrency", 4)))
    results = await asyncio.gather(*[synth_one(it, cfg, sem) for it in cfg["items"]])
    if not all(results):
        sys.exit(2)


if __name__ == "__main__":
    if sys.platform.startswith("win"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    asyncio.run(main())
