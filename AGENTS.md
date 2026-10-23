# Notes for AI coding agents

To set up or run this project for a user, follow [`skills/auto-news-shorts/SKILL.md`](skills/auto-news-shorts/SKILL.md). This file is about changing the code.

## Layout

```
src/                 pipeline (Node ESM, no build step)
  main.mjs           entry: collect → select → enrich → write → voice → render → export
  collect.mjs, rank.mjs, github.mjs, columns.mjs    sources, clustering, heat, de-duplication
  enrich.mjs, write.mjs, write-portrait.mjs, imagecheck.mjs, politics.mjs, translate.mjs
  llm.mjs            OpenAI-compatible / Codex / Antigravity text and vision calls
  tts/               Edge, Qwen3-TTS, GPT-SoVITS, MiniMax voice-over (+ Python helpers)
  timeline.mjs       audio placement, subtitles, title/description/chapters
  render/            Remotion bridge, legacy Chrome renderer, cover templates
  export.mjs         the upload kit (runs/<run>/package/)
  workbench/         local review UI (server.mjs + index.html; UI text is Chinese)
remotion/            Remotion compositions (vertical episode)
assets/host/         host images (neutral placeholder)
scripts/             audit, placeholder host and sound-effect generators
tests/               node:test, offline (no network, no AI calls)
```

## Rules

- `npm test` and `npm run check` must pass. Tests are offline; stub `fetch` or mock modules instead of calling real APIs.
- Keep `//` comments at the end of a line, never in the middle of an expression.
- Edit files with an editor tool, not shell one-liners: backslashes and `${}` get mangled. Run `node --check` on edited `.mjs` files.
- Prompts and UI strings are Chinese because the videos and their audience are. Code comments may be Chinese or English.
- Do not add upload or login automation for video platforms. See `docs/publishing-guide.md`.
- Never commit secrets, cookies, `runs/`, `public/`, voices, or third-party binaries. Every published file must be listed in `release-files.json`, and `npm run audit` must pass.
