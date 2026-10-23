# Configuration

Settings come from three places, in increasing priority:

1. **`config.json`**: shared defaults, committed. Every section has a `_doc` field explaining it.
2. **`config.local.json`**: your machine-specific values and secrets, git-ignored. Start from `config.local.example.json`. Any key here overrides the same key in `config.json`, and nested objects are merged.
3. **Environment variables**, read from the shell or from `.env` when you use the npm scripts:
   - `LLM_API_KEY`: the LLM key (or the variable named in `llm.apiKeyEnv`)
   - `LLM_BASE_URL`, `LLM_MODEL`: override `llm.baseUrl` / `llm.model`
   - `CHROME_PATH`: browser location

`workflow.json` holds the two review switches. The workbench edits it, so you can also change them there.

## Sections of `config.json`

| Section | What it controls |
|---|---|
| `channel` | `name` (intro, file names), `titleSign` (the `【…】` prefix of every title), closing line and badge |
| `host` | Host images folder and name, see [custom-host.md](custom-host.md) |
| `cover` | Cover style. `hook` = big headline + web window + host (`hookPortrait` P1/P2/P3, `hookLandscape` L1/L2/L3); `classic` = older layouts |
| `columns` | The shows. Each one has its own sources, rules, story count and texts (below) |
| `video` | `subtitleMaxChars`, default `windowHours` |
| `select` | `politicsFilter`: stop at topic review when a story is political or unsure |
| `tts` | Voice engine: `provider` = `edge` / `qwen3` / `gptsovits` / `minimax`, plus per-engine options |
| `llm` | Text model: `provider`, `baseUrl`, `model`, `reasoningEffort`, `vision`, `fallback`, `batchSize`, `concurrency` |
| `render` | `engine` (`remotion` vertical, maintained; `chrome` horizontal, legacy), background music, loudness, summary card |
| `enrich` | `screenshots` of article pages; `imageCheck` with the vision model |
| `metadata` | Tags added to every episode and the closing line of the description |

### Columns

A column is one show with its own episodes in `runs/<date>-<runSuffix>/`. The two defaults:

- `news`: daily AI news. `sinceLastEpisode: true` collects only items newer than the previous episode and drops URLs that episode already covered. `nonAI` allows up to 2 major non-AI tech stories, such as a security incident that affects everyone.
- `github`: weekly AI open-source projects (`mode: "github"`). Candidates are grouped by repository. Repos featured in an exported episode in the last `dedupeWeeks` weeks are skipped. Star counts come from the GitHub API, not from the AI.

Main keys:

| Key | Meaning |
|---|---|
| `name`, `titleTag` | Column name, shown on screen and in the description |
| `runSuffix` | Folder suffix, e.g. `news` → `runs/2026-01-31-news` |
| `sources` | Source ids from `sources.json`; `excludeAccounts` drops X accounts for this column |
| `stories` | `{min, max, hardMax}` stories per episode |
| `rules` | Topic-selection instructions for the AI editor (Chinese) |
| `titleRule`, `writeRules`, `lengthGuide` | Extra writing instructions |
| `intro*`, `outro*`, `greeting`, `descLead` | On-screen and spoken texts |
| `windowHours`, `sourceOptions` | Time window; per-source overrides (e.g. HN hours, Reddit `day`/`week`) |

The prompts are Chinese because the videos are. Edit `rules` to change what the editor picks: which companies count as major, how strict the sourcing is, what to skip.

### Review switches (`workflow.json`)

- `collectReview`: stop after collection and AI topic selection
- `editReview`: stop after the script and after the voice-over

`npm run daily -- --auto` ignores both and runs straight through, except for the political-content stop.

## Run options

```
node src/main.mjs run [--column news|github] [--date YYYY-MM-DD] [--auto]
                      [--from collect|select|enrich|write|voice|render|export]
                      [--stop-after select|write|voice] [--stills] [--preview SECONDS]
```

- `--from STAGE` redoes that stage and everything after it, reusing earlier results.
- `--stills` renders preview frames and covers only.
- `--preview 60` renders the first 60 seconds with the legacy engine.

The run folder `runs/<date>-<column>/` keeps every intermediate file: `candidates.json`, `stories-*.json`, `script.json`, `timeline.json`, audio, `run.log`. You can inspect it or edit it by hand and resume with `--from`.
