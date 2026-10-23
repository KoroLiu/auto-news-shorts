---
name: auto-news-shorts
description: Install, configure, run and troubleshoot auto-news-shorts (daily AI news → Chinese vertical short video with free TTS and Remotion). Use when the user wants to set up this repo on their machine, make an episode, customize sources/host/voice, or fix a failed run.
---

# auto-news-shorts

You are helping a user, often a beginner, run this repository on their own computer. Work in the repo root. Explain each step in plain words, in the user's language.

## Ground rules

- **Never print or echo secrets.** API keys go in `.env` or `config.local.json`, both git-ignored. When checking that a key exists, report "set / not set", never its value.
- **Never upload or publish videos for the user.** This project ships no upload code, on purpose. If asked, point to `docs/publishing-guide.md` and explain the account risks. Do not write upload automation unless the user explicitly insists after reading it.
- **Don't add the user's private material to git**: voice samples, character art, cookies, `runs/`. Keep it in git-ignored folders.
- Prefer the user's existing tools: their Python environment manager, their browser. Ask before installing large things such as CUDA PyTorch or TTS models.
- Check before claiming: run the command and read the output.

## 1. Check the machine

Run `node -v` (needs ≥ 22.9), `ffmpeg -version`, `ffprobe -version`, and find Chrome/Edge and Python 3. Then:

```bash
npm ci
npm run setup
```

`npm run setup` prints ✅/❌ per item. For each ❌, follow `docs/setup.md`. Typical fixes:

- ffmpeg missing: install it or unzip a build into `tools/ffmpeg/`.
- Python missing: install Python 3.10+, or point `tts.python` in `config.local.json` at an existing environment.

## 2. Configure

1. Copy `.env.example` to `.env` and ask the user to paste their LLM key into `LLM_API_KEY`. Do not type the key yourself. The default provider is DeepSeek. Other OpenAI-compatible APIs work through `LLM_BASE_URL` / `LLM_MODEL`; set `LLM_VISION_MODEL` to that provider's vision model or leave it empty.
2. Copy `config.local.example.json` to `config.local.json` only if machine-specific values are needed (paths, vision model, local TTS).
3. In `config.json`, set `channel.name` and `channel.titleSign` to the user's channel.
4. Optional:
   - X/Reddit sources via OpenCLI (`docs/setup.md#x-and-reddit-sources-opencli`)
   - Qwen3-TTS or GPT-SoVITS voice cloning (needs an NVIDIA GPU, and a voice the user has the right to use)
   - a custom host character (`docs/custom-host.md`, rights warning included)

## 3. Make an episode

- Hands-off: `npm run daily -- --auto` (news) or `npm run weekly -- --auto` (GitHub projects).
- With review: `npm run workbench` opens http://127.0.0.1:3220. The user reviews topics, script, voice and preview frames there.
- The result is `runs/<date>-<column>/package/`: video, two covers, `metadata.txt`. Show the user where it is and what each file is for.

A run can stop on purpose:

- at a review step (`status.json` stage `review-*`)
- when a story looks political (`select.politicsFilter`)

Tell the user what is waiting for them. Do not bypass the stop.

## 4. When something fails

1. Read the end of `runs/<run>/run.log` and `runs/<run>/status.json`.
2. Look up the symptom in `docs/troubleshooting.md`.
3. Resume from the failed stage instead of starting over: `node src/main.mjs run --column news --from <stage>`, where stage is one of `collect`, `select`, `enrich`, `write`, `voice`, `render`, `export`.
4. If you change code, run `npm test` and `npm run check` afterwards.

## 5. Customizing

- Topic rules, story counts, on-screen texts: `config.json` → `columns.<id>` (see `docs/configuration.md`).
- Sources: `sources.json` (see `docs/sources.md`).
- Video layout: `remotion/Portrait/*.tsx`. Preview with `npm run studio` after a run has produced `public/ep/<run>/`.
- Before the user publishes their own fork, run `npm run audit` and help them put their private words in `.audit-private.txt`.
