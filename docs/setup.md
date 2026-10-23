# Setup

Tested on Windows 11. Steps for macOS and Linux are similar; paths will differ.

Run `npm run setup` at any time: it checks everything below, installs `edge-tts`, downloads the logo icon pack, and records a test voice clip. Each ❌ line tells you what is missing.

Machine-specific values (paths, keys) go in **`config.local.json`**: copy `config.local.example.json` and fill in only what you need. That file is git-ignored.

## Required

### Node.js 22.9 or newer

- Download: https://nodejs.org (LTS)
- Verify: `node -v`
- Then, in the repo folder: `npm ci` (installs Remotion and the other JavaScript packages)

### ffmpeg (with ffprobe)

Used to mix audio, measure durations, normalize loudness and convert images.

- Windows: download a "full" or "essentials" build from https://www.gyan.dev/ffmpeg/builds/ or https://github.com/BtbN/FFmpeg-Builds/releases. Unzip it, then either add its `bin` folder to `PATH` or copy the folder to `tools/ffmpeg/` inside this repo, so that `tools/ffmpeg/bin/ffmpeg.exe` exists.
- macOS: `brew install ffmpeg`. Linux: `sudo apt install ffmpeg`.
- Verify: `ffmpeg -version` and `ffprobe -version`
- A custom location goes in `config.local.json`: `{"render": {"ffmpegPath": "<full path to ffmpeg.exe>"}}`

### Google Chrome or Microsoft Edge

Used for article screenshots, covers and page reading. Remotion downloads its own headless browser on first render.

- Found automatically in the standard install folders. Otherwise set `render.chromePath` in `config.local.json`, or the `CHROME_PATH` environment variable.

### Python 3.10+ (for Edge TTS)

- Any Python 3 works: https://www.python.org/downloads/, or a conda environment if you use Anaconda/Miniconda.
- `npm run setup` runs `pip install -U edge-tts` in the Python it finds (`python`, `py -3`, `python3`, or `tts.python` in `config.local.json`).
- To keep it isolated, create an environment first and point `tts.python` at it:
  - conda: `conda create -n news-tts python=3.12 -y`, then `tts.python` = the env's `python.exe`
  - venv: `python -m venv .venv-tts`, then `tts.python` = `.venv-tts/Scripts/python.exe` (Windows)

### An LLM API key

Any OpenAI-compatible chat API. The default is DeepSeek:

1. Create a key at https://platform.deepseek.com
2. Put it in `.env` as `LLM_API_KEY=...` (copy `.env.example`), or in `config.local.json` as `{"llm": {"apiKey": "..."}}`

Other providers: set `LLM_BASE_URL` and `LLM_MODEL` in `.env`. The model must handle long Chinese prompts and return JSON.

## Optional

### X and Reddit sources: OpenCLI

X has no free read API, and Reddit blocks anonymous access, so these two sources go through **your own logged-in Chrome** using [OpenCLI](https://github.com/jackwener/OpenCLI) (Apache-2.0). Without it they are skipped and everything else still works.

1. `npm install -g @jackwener/opencli`
2. Install the OpenCLI browser extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk) in the Chrome profile where you are logged in to X (and Reddit).
3. `opencli doctor`: it should report the extension as connected.
4. In `sources.json`, for the `x` and `reddit` sources, optionally set `chromeProfileName` (the Chrome profile name shown in Chrome's profile menu; the pipeline opens it when Chrome isn't running) and `profile` (an OpenCLI profile alias if you use several).

OpenCLI installed through [Agent-Reach](https://github.com/Panniantong/Agent-Reach) is found automatically as well.

### Vision model (picture check)

After writing, a vision model drops unrelated pictures (stock photos, decorative art, screenshots of the wrong page) and captions the rest. Without it, covers and videos can show unrelated images.

- Default: `LLM_VISION_MODEL=deepseek-flash` in `.env`, which uses the same endpoint and key as the text model.
- Another provider: set `LLM_VISION_MODEL` to one of its vision models, or configure `llm.vision` in `config.local.json` with its own `baseUrl` / `model` / `apiKeyEnv`.
- No vision model: leave `LLM_VISION_MODEL` empty. The check is skipped and simple rules pick the pictures.

### Qwen3-TTS: free voice cloning on your GPU

[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) (Apache-2.0) clones a voice from a few seconds of sample audio. It needs an NVIDIA GPU; 8 GB of VRAM is enough for the 1.7B model.

1. Create an environment and install the package (from the Qwen3-TTS README):
   ```bash
   conda create -n qwen3-tts python=3.12 -y
   conda activate qwen3-tts
   pip install -U qwen-tts soundfile librosa
   ```
   Install a CUDA build of PyTorch that matches your GPU from https://pytorch.org/get-started/locally/ if `qwen-tts` did not pull one in.
2. Download the model, e.g. `huggingface-cli download Qwen/Qwen3-TTS-12Hz-1.7B-Base --local-dir <models folder>/Qwen3-TTS-12Hz-1.7B-Base` (or with `modelscope download`).
3. Make a voice pack: `voices/<name>/voice.json` + a clean 5–15 s `sample.wav` of **a voice you have the right to use** (your own is best):
   ```json
   {"ref": "sample.wav", "refText": "exact words spoken in sample.wav"}
   ```
4. `config.local.json`:
   ```json
   {"tts": {"provider": "qwen3", "qwen3": {"python": "<env>/python.exe", "model": "<models folder>/Qwen3-TTS-12Hz-1.7B-Base", "voice": "<name>"}}}
   ```

Every sentence is checked for voice similarity and sane duration and re-read if it drifts (`minSim`, `tries`).

### GPT-SoVITS

[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) (MIT) is another free local voice-cloning option. Unpack the Windows bundle, put a trained voice (`.ckpt` + `.pth` + a 3–10 s reference clip) in `voices/<name>/`, and set:

```json
{"tts": {"provider": "gptsovits", "gptsovits": {"dir": "<GPT-SoVITS folder>", "voice": "<name>"}}}
```

The pipeline starts its `api_v2.py` server when needed.

### Background music

`render.portrait.bgm.file` takes a path relative to the repo root, e.g. `assets/music/bgm.mp3`. Use music you have the rights to. The track loops and fades automatically.

## Next

- Make an episode: `npm run daily -- --auto`, or step by step with `npm run workbench`.
- If something fails, see [troubleshooting.md](troubleshooting.md).
