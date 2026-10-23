# News sources

All sources live in `sources.json`. Each column picks the ids it wants in `config.json` → `columns.<id>.sources`. Set `"enabled": false` to switch one off everywhere.

## Source types

| `type` | What it reads | Notes |
|---|---|---|
| `rss` | Any RSS/Atom feed | The easiest way to add a site. [RSSHub](https://github.com/DIYgod/RSSHub) can make feeds for sites that have none |
| `x_accounts` | Recent posts of listed X accounts | Needs OpenCLI and your logged-in Chrome ([setup](setup.md#x-and-reddit-sources-opencli)) |
| `reddit` | Top posts of listed subreddits | Needs OpenCLI as well |
| `hn` | Hacker News front page plus stories over 40 points | `hours` (default 36) |
| `github_trending` | github.com/trending (daily or weekly) | Star gains are parsed from the page |
| `github_archive` | The daily trending lists saved by earlier runs | Feeds the weekly column |
| `hf_trending`, `hf_papers`, `hf_orgs` | Hugging Face trending models, daily papers, official org pages | |
| `anthropic_news` | anthropic.com/news (no RSS) | |
| `digest` | AINews (smol.ai) daily digest | |

## Common fields

| Field | Meaning |
|---|---|
| `id` | Referenced from `columns.*.sources` |
| `kind` | `official` (first-hand), `media`, `aggregator`, `community`, `trending`, `release`. Official and first-hand media count most when the AI judges sourcing |
| `lang` | `en` / `zh`. English candidates are machine-translated for the workbench |
| `aiOnly` | `true` if everything in the feed is about AI; otherwise items are filtered by AI keywords |
| `techWide` | Also keep big non-AI tech news from this source (only for columns with `nonAI`) |
| `sameOutlet` | Another feed of the same site; an article in both counts once |

## Adding an RSS source

```json
{"id": "my-blog", "name": "My Favourite Blog", "type": "rss", "kind": "media", "lang": "en",
 "url": "https://example.com/feed.xml", "aiOnly": false, "enabled": true}
```

Then add `"my-blog"` to the `sources` list of the column(s) that should use it.

## How candidates are ranked

Items from all sources are clustered by URL and by brand + version number, so that "Kimi K3.1" and "Kimi3.1" end up in one group. Each group gets a heat score from the number of independent sources, official sources, Techmeme and HN presence, engagement, images and freshness.

The AI editor sees the top groups with their heat rank. It must explain why it skipped any of the top 10, and every episode writes a heat table (`选题热度榜.md`) to the run folder for review. Items covered by the previous episode are removed by URL before ranking, without asking the AI.
