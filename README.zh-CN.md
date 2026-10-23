# auto-news-shorts

**把每天的 AI 科技新闻，自动做成一条竖屏短视频，几乎每一步都免费。**

[English](README.md)

auto-news-shorts 会从几十个来源采集资讯，让大模型挑选新闻、写口播稿，再用免费配音念出来，最后用 Remotion 渲染成 1080×1920 的竖屏视频。做完你会拿到一个**投稿素材包**：视频、横竖两张封面、标题、简介、标签、分段章节。你自己把它传到 B 站、抖音、快手、视频号、YouTube Shorts 等平台就行。

## 亮点

1. **几乎全流程免费**：只有选题和写稿要调大模型接口，用 DeepSeek 一期大约几毛钱。配音（Edge TTS / Qwen3-TTS / GPT-SoVITS）、出片（Remotion + ffmpeg）全部免费。
2. **采集来源多**：各大 AI 公司的官方 X 账号和博客、科技媒体、Hacker News、Reddit、GitHub 热榜、Hugging Face、Techmeme 都能采。来源和选题规则都写在设置文件里，可以自己改。
3. **一条命令做完，也能一步步审核**：`npm run daily` 从采集一路做到成片。本地工作台可以在每一步停下来：审核选题、改稿、单句重新配音、预览画面。
4. **真实踩坑经验**：[排错指南](docs/troubleshooting.md) 收录了实际出片时遇到的问题。[投稿指南](docs/publishing-guide.md) 讲多平台自动投稿的做法和坑，但不提供投稿代码。

## 花不花钱

| 步骤 | 用什么 | 费用 |
|---|---|---|
| 采集资讯 | RSS、公开接口；X 和 Reddit 用 [OpenCLI](https://github.com/jackwener/OpenCLI)（可选） | 免费 |
| 选题、写稿 | 任何 OpenAI 兼容的大模型接口（默认 [DeepSeek](https://api-docs.deepseek.com)） | 按量付费，一期约 1 到 5 毛 |
| AI 看图挑配图 | 能看图的模型（默认 DeepSeek 的 `deepseek-flash`，同一个密钥） | 按量付费，很少 |
| 候选新闻翻译 | Bing 网页翻译 | 免费 |
| 配音 | [Edge TTS](https://github.com/rany2/edge-tts)（默认）/ [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) / [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 免费（后两个要 NVIDIA 显卡） |
| 渲染 | [Remotion](https://www.remotion.dev) + [ffmpeg](https://ffmpeg.org) | 个人免费（见 [Remotion 许可证](https://www.remotion.dev/docs/license)） |
| 投稿 | 自己手动上传（见投稿指南） | 免费 |

## 快速开始

在 Windows 11 上测试过；macOS 和 Linux 大部分应该能用，但没测过。

```bash
git clone https://github.com/KoroLiu/auto-news-shorts.git
cd auto-news-shorts
npm ci
npm run setup
```

`npm run setup` 会检查 Node、ffmpeg、Chrome/Edge、Python，给 Python 装上 `edge-tts`，再试着生成一段配音。它标了 ❌ 的项，照 [docs/setup.md](docs/setup.md) 处理就行。

接着填写大模型密钥：把 `.env.example` 复制成 `.env`，填上：

```
LLM_API_KEY=sk-...
```

默认用 DeepSeek（`https://api.deepseek.com`）：`deepseek-v4-pro` 写稿，`deepseek-flash` 看图挑配图（`LLM_VISION_MODEL`），会扔掉库存图和无关截图。想换别家，设置 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_VISION_MODEL`；那家没有看图模型就把 `LLM_VISION_MODEL` 留空，跳过看图。

然后做一期：

```bash
npm run daily -- --auto
```

`--auto` 表示中途不停下审核。做好的东西在 `runs/<日期>-news/package/` 里：视频、横竖两张封面、`metadata.txt`（标题和各平台缩短版、标签、分段章节、简介）。

想一步步审核，就打开工作台：

```bash
npm run workbench
```

**不想自己折腾？**让 Claude Code、Codex 这类 AI 编程助手读一下 [`skills/auto-news-shorts/SKILL.md`](skills/auto-news-shorts/SKILL.md)，它会按你电脑的情况，一步步帮你装好、配好、排错。

## 两个板块

- **news（每日 AI 资讯）**：每期 4～6 条，只采上一期之后的新闻，上一期讲过的自动去掉。
- **github（每周 GitHub 项目）**：每周介绍 3～6 个热门 AI 开源项目，最近 8 周介绍过的项目自动跳过。

## 能力边界

- **以竖屏为主**：维护中的模板是 1080×1920（Remotion）。旧的横屏模板（`render.engine: "chrome"`）还在，但不再维护，可能需要自己调整。
- **不含投稿代码**：流程做到投稿素材包为止。自动投稿有封号风险，平台规则也常变，见[投稿指南](docs/publishing-guide.md)。
- **X 和 Reddit 是可选的**：要通过 OpenCLI 用你自己登录的 Chrome 读取。没装就自动跳过这两个来源，其他照常。
- **建议人工把关**：选题规则要求有官方或一手来源，标题里的数字也必须能在原文里找到；但 AI 仍可能出错，发布前请看一遍稿子。
- **政治新闻只标注、不剔除**：`select.politicsFilter` 默认开启，有涉及政治的新闻时会停在选题审核，由你决定留不留。

## 换成你自己的主持人

视频和封面上有一个主持人形象，仓库里只放了一个中性的占位剪影。想换成自己的角色，见 [docs/custom-host.md](docs/custom-host.md)。

> ⚠️ 只使用你自己画的、你拥有版权的，或者授权允许你使用的形象。游戏、动漫等作品里的角色通常受版权保护，用它们发布视频的风险由你自己承担。

## 文档

- [安装](docs/setup.md)
- [设置项说明](docs/configuration.md)
- [信息源](docs/sources.md)
- [自定义主持人](docs/custom-host.md)
- [排错指南](docs/troubleshooting.md)
- [投稿指南（不含代码）](docs/publishing-guide.md)

文档正文是英文，设置项和报错提示里有中文说明。

## 许可证

本项目代码采用 [MIT](LICENSE)。第三方工具各按自己的许可证使用，包括 [Remotion](https://www.remotion.dev/docs/license)（部分公司需要购买授权）、各配音引擎、OpenCLI，以及你采集的各个网站；转用它们的内容时，请遵守对方的条款和版权。
