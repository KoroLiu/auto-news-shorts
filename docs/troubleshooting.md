# Troubleshooting

Each entry is **symptom → cause → fix**. Check `runs/<run>/run.log` first: every step logs there.

## Setup and running

**`找不到 AI 接口密钥` / the run stops before collecting**
→ No LLM key. → Put `LLM_API_KEY=...` in `.env`, or `llm.apiKey` in `config.local.json`. Scripts started directly with `node` do not read `.env`; use the npm scripts or set the variable in your shell.

**`找不到 Chrome/Edge 浏览器`**
→ The browser is not in a standard location. → Set `render.chromePath` in `config.local.json` or the `CHROME_PATH` environment variable.

**`spawn ffmpeg ENOENT` or `无法读取时长`**
→ ffmpeg/ffprobe are not on `PATH`. → Install them ([setup](setup.md#ffmpeg-with-ffprobe)), put them in `tools/ffmpeg/bin/`, or set `render.ffmpegPath`.

**`今天的任务正在运行中`**
→ A previous run of the same episode crashed and left `runs/<run>/.lock` behind. → Make sure no run is active, delete that `.lock` file, and start again.

**Windows: scripts behave differently in an IDE terminal vs a normal terminal**
→ Some sandboxed tool shells see a virtualized `AppData`. → When a folder or permission problem makes no sense, reproduce it in a normal PowerShell window.

## Collection and topic selection

**X or Reddit says `未找到 OpenCLI` or returns nothing**
→ OpenCLI or its Chrome extension is not connected. → Run `opencli doctor`, make sure the extension is installed in the Chrome profile that is logged in to X, and set `chromeProfileName` in `sources.json` so the pipeline can open that profile. These sources are optional.

**An obviously big story was not picked**
→ Usually one of these:
1. The same model is spelled differently across sources, so its heat is split.
2. Media articles have no like counts and rank low.
3. The column `rules` exclude it, e.g. "unreleased" for an official teaser.

→ Open `runs/<run>/选题热度榜.md` to see its heat rank and the AI's reason for skipping it. Then adjust `rules`, or add the story by hand in the workbench (选题审核 → manual item).

**A formula or score suddenly behaves oddly after an edit**
→ A `//` comment inserted in the middle of a long one-line expression silently comments out the rest of it. → Keep comments at the end of a line. After editing the ranking, recompute the score of one known item.

**Techmeme items read the wrong article**
→ Techmeme's RSS link is the day's summary page, not the article. → The original link is taken from the item description (`origUrl`). If a custom aggregator feed behaves the same way, handle it like this.

**Political stories stop the run**
→ `select.politicsFilter` is on and the AI or the keyword list flagged a story. → Remove it or keep it in the workbench and continue. Set `politicsFilter: false` to turn the gate off.

## Script and pictures

**Pictures are unrelated (stock photos, decorative art)**
→ Sites' share images (`og:image`) are often stock photos. → Make sure a vision model is configured (`LLM_VISION_MODEL`, see [setup](setup.md#vision-model-picture-check)). The log should say `AI 看图把关：用 N 张，扔掉 M 张`. If it says `未配置看图模型`, the check was skipped.

**Vision calls hang on the first attempt**
→ Seen with some providers. → The pipeline waits 90 s first and retries up to 3 times. GIFs: the first frame is often blank, so four frames are tiled into one image. WebP is converted to JPG first.

**A number in the title is wrong**
→ The AI made it up or rounded it. → Titles are checked: every number must appear in the source text, within ±3% or as an equivalent unit (22.9万 ↔ 229,000). If none survives, the title falls back to the first two headlines.

## Voice-over

**Edge TTS fails or is very slow**
→ Network problem reaching Microsoft's service. → Retry, or check your proxy. `npm run setup` records a test clip.

**Qwen3-TTS: one sentence sounds like a different person**
→ Voice cloning drifts sometimes. → Each sentence is compared with the sample (`minSim`) and re-read up to `tries` times. Raise `minSim` slightly, or mark the sentence for re-reading in the workbench (配音试听).

**Speed change makes subtitles drift**
→ Old versions changed speed without rescaling timing. → Use `tts.qwen3.speed` (or the engine's own rate). Subtitles are rescaled together with the audio.

## Rendering

**A pale box appears around the host on the cover**
→ CSS `drop-shadow` on transparent PNGs renders badly in headless Chrome. → Bake outlines into the PNG ([custom-host](custom-host.md)).

**Covers miss a good screenshot**
→ A story shows at most 2 pictures; extra good ones move to `mediaRejected` with `ai.keep = true`. → Covers already look there. If you change cover logic, keep that.

**Output is too quiet on phones**
→ Without normalization the mix ends up around −20 LUFS. → `render.portrait.loudness` (default −16) applies one overall gain after rendering, so voice and music keep their balance.

**Text is cut off by app buttons on the phone**
→ Short-video apps overlay the right and bottom edges. → The vertical template keeps important content inside a safe area measured from real Douyin and Bilibili screenshots (`remotion/Portrait/common.tsx` → `SAFE`). Keep new elements inside it.

## Translation in the workbench

**Candidates show only English**
→ The free Bing web translator changed or is blocked. → It is optional; the run continues. The token-scraping regex lives in `src/translate.mjs`.
