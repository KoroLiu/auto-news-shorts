// 每日竖屏视频（DailyPortrait）：读 public/ep/<期>/episode.json（由 ai-daily/src/render/remotion.mjs 生成），整期出片。
// 结构：开场频道名 →（咔哒）概览 → 每条新闻（按句子分成 B 截图 / A 大数字 / C 卡片 几拍）+ D 一句话总结 → 结尾四连。
import React from "react";
import { AbsoluteFill, Audio, CalculateMetadataFunction, Easing, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background, Burst, C, clamp, Cue, FONT, Header, Host, Icon, NUM, SAFE, Subtitle, useSpringIn, Wipe } from "./common";
import { EndCard, Intro } from "./scenes";

// focus：配图推镜头推向哪一点（0～1，左上为 0,0），不给就推向正中
type Media = { kind: "image" | "tweet"; src?: string; caption?: string; name?: string; handle?: string; textZh?: string; date?: string; t0: number; t1: number; focus?: { x: number; y: number } };
type CardT = { icon: string; heading: string; body: string };
type BeatT = { scene: "A" | "B" | "C"; media?: number; t0: number; t1: number; cards: { card: number; t0: number }[] };
type Seg = {
  type: "intro" | "item" | "outro"; id: string; audio: string; duration: number; offset: number; cues: Cue[]; mouth: number[]; from: number; len: number; end: number;
  // item
  no?: number; title?: string; short?: string; sourceLine?: string; tab?: string; ribbon?: string; ribbonSub?: string; logo?: string | null; cards?: CardT[];
  hero?: { v: string; k?: string; small?: string } | null; chip?: { v: string; k: string } | null; comment?: string; stamp?: string; media?: Media[]; beats?: BeatT[];
  concl?: { audio: string; duration: number; offset: number; from: number; len: number; mouth: number[]; speak: { t0: number; t1: number } };
  // intro
  list?: { title: string; logo: string | null }[];
};
export type Episode = { fps: number; sting: number; duration: number; channel: string; column: string; dateLabel: string; dateShort: string; itemCount: number; segments: Seg[]; bgm?: string | null };
export type EpisodeProps = { ep: string; episode?: Episode };

export const calcEpisode: CalculateMetadataFunction<EpisodeProps> = async ({ props }) => {
  const episode: Episode = await fetch(staticFile(`${props.ep}/episode.json`)).then((r) => r.json());
  return { durationInFrames: Math.ceil(episode.duration * episode.fps), fps: episode.fps, props: { ...props, episode } };
};

const sec = (s: number, fps: number) => Math.round(s * fps);
const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1); // 落地慢、尾巴长：进场用
const EASE_INOUT = Easing.bezier(0.65, 0, 0.35, 1); // 两头慢：卡片变形、推镜头用

// ───────── 白板：只给「一整块内容」的拍用（大数字、截图、数字漏斗、没有卡片时的标题），大小贴着内容；换拍时变形成下一拍的大小 ─────────
// 好几张卡片的拍不用白板（白板只放一张卡片、下面大片空白很生硬），卡片本身就是主持人扒着的东西
type Rect = { l: number; t: number; w: number; h: number; r: number };
const distinctCards = (b: BeatT) => b.cards.filter((c, i, a) => a.findIndex((x) => x.card === c.card) === i);
const boardRect = (scene: string, first: boolean): Rect => {
  if (scene === "A") return { l: SAFE.l, t: 830, w: SAFE.rLow - SAFE.l, h: 470, r: 40 }; // 右边到 860：y≥860 那段避开平台右侧按钮
  if (scene === "B") return { l: SAFE.l, t: first ? 550 : 450, w: SAFE.rLow - SAFE.l, h: first ? 560 : 660, r: 28 };
  // C：卡片在 x 120～700，白板四周多留一点边，主持人趴在白板右边
  const t = (first ? 560 : 470) - 24;
  return { l: 96, t, w: 620, h: 1296 - t, r: 34 };
};
const MORPH = 0.5; // 变形用时（秒）；下一拍的内容在变形快结束时才出来
const Board: React.FC<{ rects: (Rect | null)[]; starts: number[] }> = ({ rects, starts }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f / fps;
  const i = starts.reduce((k, s, j) => (t >= s ? j : k), 0);
  const k = i === 0 ? 1 : interpolate(t, [starts[i], starts[i] + MORPH], [0, 1], { ...clamp, easing: EASE_INOUT });
  const pa = i === 0 ? null : rects[i - 1];
  const pb = rects[i];
  if (!pa && !pb) return null;
  // 这一拍没有白板：上一块淡出；上一拍没有白板：这一块从稍小淡入
  const a = pa || pb!;
  const b = pb || pa!;
  const mix = (x: number, y: number) => x + (y - x) * (pa && pb ? k : 1);
  const enter = i === 0 ? spring({ frame: f - 0.05 * fps, fps, config: { damping: 200 } }) : 1;
  // 下一拍没有白板时，上一拍的内容已经换掉了，空白板要很快收掉（0.15 秒），别闪一块空白
  const vis = !pb ? interpolate(t, [starts[i], starts[i] + 0.15], [1, 0], clamp) : !pa ? k : 1;
  const o = enter * vis;
  return (
    <div style={{ position: "absolute", left: mix(a.l, b.l), top: mix(a.t, b.t), width: mix(a.w, b.w), height: mix(a.h, b.h), borderRadius: mix(a.r, b.r), background: "#fff", boxShadow: "0 30px 70px rgba(11,42,122,.18)", opacity: o, scale: String(0.94 + 0.06 * o), zIndex: 3 }} />
  );
};
// 下一拍内容的进场：第一拍等白板出来，后面几拍等变形快结束
const contentIn = (t: number, first: boolean) => {
  const d = first ? 0.25 : MORPH - 0.15;
  return { opacity: interpolate(t, [d, d + 0.25], [0, 1], clamp), filter: `blur(${interpolate(t, [d, d + 0.25], [8, 0], clamp)}px)` };
};

// ───────── 数字滚轮：每一位像老虎机一样多转一圈再停到目标数字，从左到右依次落定 ─────────
const DigitWheel: React.FC<{ text: string; size: number; t: number; start: number }> = ({ text, size, t, start }) => {
  const H = Math.round(size * 1.05);
  let n = 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-start", fontVariantNumeric: "tabular-nums", height: H }}>
      {[...text].map((ch, i) => {
        if (!/[0-9]/.test(ch)) return <span key={i} style={{ lineHeight: `${H}px` }}>{ch}</span>;
        const stops = 10 + Number(ch);
        const at = start + n++ * 0.08;
        const p = interpolate(t, [at, at + 1.4], [0, 1], { ...clamp, easing: EASE_OUT });
        return (
          <span key={i} style={{ display: "inline-block", height: H, overflow: "hidden" }}>
            <span style={{ display: "flex", flexDirection: "column", translate: `0px ${-p * stops * H}px` }}>
              {Array.from({ length: stops + 1 }, (_, j) => (
                <span key={j} style={{ height: H, lineHeight: `${H}px` }}>{j % 10}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
};

// ───────── 数字漏斗：一拍里每句话都讲一个带单位的数字时，按讲到的顺序一行一行出来（代替卡片） ─────────
// 只在很确定的时候用：这一拍 4～12 秒、卡片最多 2 张、2～4 句话、每句恰好一个带单位的数字；否则照旧出卡片
type LadderRow = { v: string; unit: string; text: string; t0: number; val: number };
const LADDER_NUM = /(?<![A-Za-z0-9.-])([0-9][0-9.,]*)\s*((?:万|亿)?(?:%|倍|个|小时|天|年|人|款|家|名|次|种|美元|元|秒|分钟|项|篇|张|台|颗|GB|TB))(?![A-Za-z0-9])/g;
const ladderRows = (seg: Seg, b: BeatT): LadderRow[] | null => {
  const span = b.t1 - b.t0;
  if (span < 4 || span > 12 || new Set(b.cards.map((c) => c.card)).size > 2) return null;
  const cues = seg.cues.filter((c) => (c.t0 + c.t1) / 2 >= b.t0 && (c.t0 + c.t1) / 2 < b.t1);
  if (cues.length < 2 || cues.length > 4) return null;
  const rows: LadderRow[] = [];
  for (const c of cues) {
    const ms = [...c.text.matchAll(LADDER_NUM)];
    if (ms.length !== 1) return null;
    const m = ms[0];
    const val = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(val) || (m[2] === "年" && val >= 1900 && val <= 2100)) return null;
    const v = /^\d{5,}$/.test(m[1]) ? m[1].replace(/\B(?=(\d{3})+$)/g, ",") : m[1];
    rows.push({ v, unit: m[2], text: c.text, t0: c.t0, val });
  }
  return rows;
};

// ───────── 小标题牌：logo + 新闻短标题（big=飘带式大标题） ─────────
const TitleTag: React.FC<{ seg: Seg; p: number; big?: boolean }> = ({ seg, p, big }) => {
  const text = seg.ribbon || seg.title || "";
  const size = big ? Math.min(54, Math.floor(640 / Math.max(8, text.length * 0.62))) : Math.min(34, Math.floor(560 / Math.max(8, text.length * 0.62)));
  return (
    <div style={{ position: "absolute", left: SAFE.l - 10, top: big ? 392 : 390, maxWidth: SAFE.r - SAFE.l + 10, display: "flex", alignItems: "center", gap: big ? 22 : 14, padding: big ? "18px 40px 20px 22px" : "10px 26px 10px 12px", borderRadius: big ? 24 : 18, background: `linear-gradient(90deg,${C.deep},${C.blue})`, color: "#fff", fontFamily: FONT, rotate: "-2.5deg", translate: `${(1 - p) * -1000}px 0px`, boxShadow: "0 14px 30px rgba(11,42,122,.3), inset 0 -6px 0 rgba(0,0,0,.15)", zIndex: 6 }}>
      <div style={{ width: big ? 84 : 56, height: big ? 84 : 56, borderRadius: big ? 22 : 14, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        {seg.logo ? <Img src={seg.logo} style={{ width: big ? 64 : 40, height: big ? 64 : 40 }} /> : <Icon name="sparkles" color={C.blue} size={big ? 56 : 36} />}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: size, fontWeight: 900, letterSpacing: 1, lineHeight: 1.12, whiteSpace: "nowrap" }}>{text}</div>
        {big && seg.ribbonSub ? <div style={{ fontSize: 28, fontWeight: 700, opacity: 0.88, marginTop: 6, letterSpacing: 2, whiteSpace: "nowrap" }}>{seg.ribbonSub}</div> : null}
      </div>
    </div>
  );
};

// ───────── B：截图 / 推文讲解（主持人左下角指着；卡片右边收到 x 880，躲开平台右侧按钮） ─────────
const BeatB: React.FC<{ seg: Seg; beat: BeatT; first: boolean }> = ({ seg, beat, first }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f / fps;
  const m = seg.media?.[beat.media ?? 0];
  const host = useSpringIn(0.5, 11);
  const rib = useSpringIn(0.05, 14);
  const ribbon = first ? rib : 1;
  const span = Math.max(2, beat.t1 - beat.t0);
  // 推镜头：新画面先稍大再落定；这一拍够长（≥3.5 秒）就在第 1～2 秒慢慢推近到 focus 那一点，然后停住
  const d = first ? 0.25 : MORPH - 0.15;
  const settle = interpolate(t, [d, d + 0.7], [1.08, 1], { ...clamp, easing: EASE_OUT });
  // 没指定推向哪一点时只轻推（1.08）：网页截图推到 1.25 会把左右两边的字裁掉
  const push = span >= 3.5 ? interpolate(t, [d + 0.9, d + 1.9], [1, m?.focus ? 1.25 : 1.08], { ...clamp, easing: EASE_INOUT }) : interpolate(t, [0, span], [1, 1.06], clamp);
  const fx = m?.focus ? m.focus : { x: 0.5, y: 0.5 };
  return (
    <AbsoluteFill>
      <TitleTag seg={seg} p={ribbon} big={first} />
      <div style={{ position: "absolute", left: SAFE.l, right: 1080 - SAFE.rLow, top: first ? 550 : 450, height: first ? 560 : 660, borderRadius: 28, overflow: "hidden", fontFamily: FONT, zIndex: 4, ...contentIn(t, first) }}>
        {m?.kind === "tweet" ? (
          <div style={{ padding: "50px 56px", height: "100%", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 30 }}>
              <div style={{ width: 84, height: 84, borderRadius: 42, background: `linear-gradient(135deg,#3C7BFF,${C.deep})`, color: "#fff", fontSize: 40, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center" }}>{(m.name || "X").slice(0, 1).toUpperCase()}</div>
              <div>
                <div style={{ fontSize: 38, fontWeight: 900, color: C.ink }}>{m.name}</div>
                <div style={{ fontSize: 28, color: C.muted }}>@{m.handle}</div>
              </div>
              <div style={{ marginLeft: "auto", fontSize: 56, fontWeight: 900, fontFamily: "Arial" }}>X</div>
            </div>
            <div style={{ fontSize: Math.max(24, Math.min(42, Math.floor(Math.sqrt((first ? 100000 : 130000) / Math.max(1, (m.textZh || "").length))))), lineHeight: 1.6, fontWeight: 600, color: C.ink, overflow: "hidden", flex: 1, minHeight: 0 }}>{m.textZh}</div>
            <div style={{ marginTop: "auto", fontSize: 26, color: "#98A5BC" }}>{m.date ? `${m.date} · ` : ""}中文为 AI 翻译</div>
          </div>
        ) : m?.src ? (
          <>
            <div style={{ height: 64, background: "#EEF3FB", display: "flex", alignItems: "center", gap: 12, padding: "0 24px", borderBottom: "2px solid #DCE6F8" }}>
              {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
                <div key={c} style={{ width: 18, height: 18, borderRadius: 9, background: c }} />
              ))}
              <div style={{ marginLeft: 18, flex: 1, height: 38, borderRadius: 19, background: "#fff", color: C.muted, fontSize: 22, display: "flex", alignItems: "center", padding: "0 20px", whiteSpace: "nowrap", overflow: "hidden" }}>{m.caption}</div>
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, top: 64, bottom: 0, overflow: "hidden", background: "#F2F5FA", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Img src={staticFile(m.src)} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", scale: String(settle * push), transformOrigin: `${fx.x * 100}% ${fx.y * 100}%` }} />
            </div>
          </>
        ) : null}
      </div>
      <Host pose="point" flip f={f} style={{ left: 100, top: 1090, width: 270, height: 400, translate: `${(1 - host) * -420}px ${Math.sin(t * 2.2) * 6}px`, zIndex: 5 }} />
    </AbsoluteFill>
  );
};

// ───────── A：大数字（主持人从数字牌后面升起来） ─────────
const BeatA: React.FC<{ seg: Seg; beat: BeatT; at0: number; first: boolean }> = ({ seg, beat, at0, first }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f / fps;
  const peek = useSpringIn(0.5, 10);
  const rib = useSpringIn(0.05, 14);
  const ribbon = first ? rib : 1;
  const h = seg.hero!;
  // 数字部分（可带逗号、小数点）用滚轮滚出来，前后的符号和单位（$、billion）直接显示
  const m = h.v.match(/^([^0-9]*)([0-9][0-9.,]*)(.*)$/);
  const wheelAt = (first ? 0.25 : MORPH - 0.15) + 0.15;
  const vSize = Math.min(230, Math.floor(640 / Math.max(2, h.v.length * (m ? 0.62 : 1))));
  const chipAt = seg.chip ? Math.max(1.8, (seg.cues.find((c) => c.text.includes((seg.chip!.v.match(/[0-9]+(?:\.[0-9]+)?/) || [""])[0]) && c.t0 >= at0)?.t0 ?? at0 + 2.5) - at0) : 0;
  const chip = seg.chip ? spring({ frame: f - chipAt * fps, fps, config: { damping: 9 } }) : 0;
  return (
    <AbsoluteFill>
      <TitleTag seg={seg} p={ribbon} big={false} />
      <div style={{ position: "absolute", left: 540 - 900, top: 1060 - 900, width: 1800, height: 1800, rotate: `${t * 12}deg`, opacity: 0.55, background: "repeating-conic-gradient(rgba(31,107,255,.16) 0deg 8deg, rgba(255,255,255,0) 8deg 20deg)", maskImage: "radial-gradient(closest-side, #000 30%, transparent 75%)" }} />
      <Host pose="lean" mouth={seg.mouth} f={f + at0 * fps} style={{ right: 1080 - SAFE.r, top: 452, width: 380, height: 400, scale: String(interpolate(peek, [0, 1], [0.4, 1])), opacity: Math.min(1, peek * 2), transformOrigin: "50% 100%", translate: `0px ${Math.sin(t * 2.4) * 4}px`, zIndex: 5 }} />
      <Burst text="！" p={peek} style={{ right: 460, top: 440, zIndex: 6 }} />
      <div style={{ position: "absolute", left: SAFE.l, right: 1080 - SAFE.rLow, top: 830, height: 470, zIndex: 4, fontFamily: FONT, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, ...contentIn(t, first) }}>
        {h.k ? <div style={{ fontSize: 40, fontWeight: 900, color: C.ink2, letterSpacing: 4 }}>{h.k}</div> : null}
        <div style={{ fontFamily: m ? NUM : FONT, fontSize: vSize, fontWeight: 900, color: C.blue, lineHeight: 1.05, letterSpacing: m ? -6 : 4, whiteSpace: "nowrap", display: "flex", alignItems: "flex-start" }}>
          {m ? (
            <>
              <span style={{ whiteSpace: "pre" }}>{m[1]}</span>
              <DigitWheel text={m[2]} size={vSize} t={t} start={wheelAt} />
              <span style={{ whiteSpace: "pre" }}>{m[3]}</span>
            </>
          ) : (
            h.v
          )}
        </div>
        {h.small ? <div style={{ fontSize: 30, color: C.muted, fontWeight: 700, padding: "0 40px", textAlign: "center" }}>{h.small}</div> : null}
        {seg.chip ? (
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 16, padding: "10px 28px", borderRadius: 26, background: "#FFF0F3", border: `3px solid ${C.red}`, scale: String(chip), rotate: "-3deg" }}>
            <span style={{ fontFamily: NUM, fontSize: 56, fontWeight: 900, color: C.red }}>{seg.chip.v}</span>
            <span style={{ fontSize: 30, fontWeight: 800, color: C.ink2 }}>{seg.chip.k}</span>
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

// 数字漏斗：一行一个数字，讲到哪行亮哪行；同单位的数字画长条，后面的数比前面小时，上一行的长条掉下来缩短
const Ladder: React.FC<{ rows: LadderRow[]; t: number; from: number; rect: Rect }> = ({ rows, t, from, rect }) => {
  const at = rows.map((r) => Math.max(r.t0, from));
  const rowH = Math.min(250, (rect.h - 100) / rows.length);
  const W = 540;
  const left = rect.l + 32;
  const max: Record<string, number> = {};
  const cnt: Record<string, number> = {};
  rows.forEach((r) => {
    max[r.unit] = Math.max(max[r.unit] || 0, r.val);
    cnt[r.unit] = (cnt[r.unit] || 0) + 1;
  });
  const size = (r: LadderRow) => Math.max(56, Math.min(110, rowH * 0.48, Math.floor((W - r.unit.length * 46) / (r.v.length * 0.56))));
  const rowTop = (i: number) => rect.t + 70 + i * rowH; // 第一行别贴着上面的标题牌
  const barY = (i: number) => rowTop(i) + 40 + size(rows[i]) * 1.05 + 12;
  const barW = (r: LadderRow) => Math.max(10, (W * r.val) / max[r.unit]);
  const prevOf = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (rows[j].unit === rows[i].unit) return j;
    return -1;
  };
  return (
    <>
      {rows.map((r, i) => {
        const a = at[i];
        const dim = i + 1 < rows.length ? interpolate(t, [at[i + 1], at[i + 1] + 0.3], [1, 0.42], clamp) : 1;
        const pj = prevOf(i);
        const shrink = pj >= 0 && rows[pj].val > r.val;
        const hasBar = cnt[r.unit] >= 2;
        const own = shrink ? interpolate(t, [a + 0.6, a + 0.65], [0, 1], clamp) : interpolate(t, [a + 0.15, a + 1.05], [0, 1], { ...clamp, easing: EASE_OUT });
        const g = interpolate(t, [a, a + 0.6], [0, 1], { ...clamp, easing: EASE_INOUT });
        const sz = size(r);
        return (
          <React.Fragment key={i}>
            {i > 0 ? <div style={{ position: "absolute", left: left + 10, top: rowTop(i) - 24, width: 0, height: 0, borderLeft: "16px solid transparent", borderRight: "16px solid transparent", borderTop: "20px solid #C9D9F8", opacity: interpolate(t, [a - 0.1, a + 0.2], [0, 1], clamp), zIndex: 4 }} /> : null}
            <div style={{ position: "absolute", left, top: rowTop(i), width: W + 12, fontFamily: FONT, opacity: t < a ? 0 : dim, zIndex: 4 }}>
              <div style={{ fontSize: 27, fontWeight: 800, color: C.muted, letterSpacing: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", height: 40, opacity: interpolate(t, [a, a + 0.25], [0, 1], clamp) }}>{r.text}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: NUM, fontSize: sz, fontWeight: 900, lineHeight: 1.05, letterSpacing: -3, color: shrink ? C.red : C.blue, whiteSpace: "nowrap" }}>
                  {[...r.v].map((ch, j) => (
                    <span key={j} style={{ display: "inline-block", opacity: interpolate(t, [a + 0.05 * j, a + 0.05 * j + 0.13], [0, 1], clamp), filter: `blur(${interpolate(t, [a + 0.05 * j, a + 0.05 * j + 0.13], [6, 0], clamp)}px)` }}>{ch}</span>
                  ))}
                </span>
                {r.unit ? <span style={{ fontSize: 44, fontWeight: 900, color: C.ink, opacity: interpolate(t, [a + 0.3, a + 0.5], [0, 1], clamp) }}>{r.unit}</span> : null}
              </div>
            </div>
            {hasBar ? <div style={{ position: "absolute", left, top: barY(i), width: barW(r), height: 18, borderRadius: 9, background: shrink ? C.red : `linear-gradient(90deg,${C.blue},${C.sky})`, scale: `${own} 1`, transformOrigin: "0 50%", opacity: dim, zIndex: 4 }} /> : null}
            {hasBar && shrink && t >= a && t < a + 0.65 ? <div style={{ position: "absolute", left, top: barY(pj) + (barY(i) - barY(pj)) * g, width: barW(rows[pj]) + (barW(r) - barW(rows[pj])) * g, height: 18, borderRadius: 9, background: C.blue, zIndex: 4 }} /> : null}
          </React.Fragment>
        );
      })}
    </>
  );
};

// ───────── C：卡片（放在大白板里，讲到哪张进来、亮哪张；主持人一直趴在白板右边）；讲到一串数字时换成数字漏斗 ─────────
const CARD_COLORS = [["#E07B12", "#FFF4E6", "#F5D6AE"], ["#6A4FE0", "#F2EFFF", "#D6CCF7"], ["#D6336C", "#FFEFF4", "#F6C7D6"], ["#0E9F8E", "#E9F8F5", "#BFE7DF"], ["#1F6BFF", "#EEF4FF", "#C9DBFB"], ["#2B8A3E", "#EDF8EF", "#C3E5CA"]];
const TEXTURES = ["repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 14px)", "radial-gradient(currentColor 1.6px, transparent 1.8px)", "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)"];
const BeatC: React.FC<{ seg: Seg; beat: BeatT; at0: number; first: boolean }> = ({ seg, beat, at0, first }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = f / fps + at0; // 这条配音里的时间
  const local = f / fps; // 这一拍里的时间
  const rib = useSpringIn(0.05, 14);
  const ribbon = first ? rib : 1;
  const rect = boardRect("C", first);
  const enterAt = at0 + (first ? 0.25 : MORPH - 0.15); // 白板就位、内容可以出来的时间（配音时间）
  const rows = ladderRows(seg, beat);
  // 同一张卡片被两句话讲到时只显示一次（按第一次出现的时间）
  // 卡片多于 3 张时每 3 张一页，讲到哪张翻到哪页（原来只取最后 3 张，前面讲的时候白板是空的）
  const distinct = distinctCards(beat);
  const pages = Array.from({ length: Math.ceil(distinct.length / 3) }, (_, i) => distinct.slice(i * 3, i * 3 + 3));
  const page = pages.reduce((k, p, i) => (t >= p[0].t0 - 0.15 ? i : k), 0);
  const shown = pages[page] || [];
  // 主持人等她要扒的东西出来再探头：有白板（漏斗、标题）等白板，卡片拍等第一张卡片进来
  const firstCardAt = !rows && shown[0] ? Math.max(shown[0].t0 - 0.15, enterAt) - at0 + 0.2 : 0;
  const host = useSpringIn(rows || !shown.length ? (first ? 0.4 : MORPH) : firstCardAt, 200);
  const inB = !rows && shown[2] ? spring({ frame: f - (shown[2].t0 - at0 + 0.2) * fps, fps, config: { damping: 11 } }) : 0;
  const top = first ? 560 : 470;
  const minTop = first ? 520 : 420; // 第一拍上面有大标题，头别顶到标题
  // 再往下滑，脸就进了右下角平台按钮那一列（y≥860、x≥880），所以最低到 560（眼睛约在 y 740，抖音「头像」按钮从 y 800 起）：讲到第 3 张时手扒在第 2 张边上
  const maxTop = 560;
  // 手大约在立绘从上往下 46% 的地方；对准当前那张卡片（或漏斗那一行）的中间
  let hostTop: number;
  if (rows) {
    const rowH = Math.min(250, (rect.h - 100) / rows.length);
    const at = rows.map((r) => Math.max(r.t0, enterAt));
    const cur = at.reduce((k, s, i) => (t >= s ? i : k), 0);
    const y = (k: number) => Math.min(maxTop, Math.max(minTop, rect.t + 70 + k * rowH + rowH / 2 - 276));
    const k = cur === 0 ? 1 : interpolate(t, [at[cur], at[cur] + 0.5], [0, 1], { ...clamp, easing: EASE_INOUT });
    hostTop = y(Math.max(0, cur - 1)) + (y(cur) - y(Math.max(0, cur - 1))) * k;
  } else {
    const cur = shown.reduce((k, s, i) => (t >= s.t0 - 0.1 ? i : k), 0);
    const handY = (k: number) => Math.min(maxTop, Math.max(minTop, top + k * 268 + 120 - 276)); // 卡片约 240 高，间隔 28
    const prevK = Math.max(0, cur - 1);
    const slide = shown[cur] ? interpolate(t, [shown[cur].t0, shown[cur].t0 + 0.5], [0, 1], { ...clamp, easing: EASE_INOUT }) : 1;
    hostTop = handY(prevK) + (handY(cur) - handY(prevK)) * slide;
  }
  const cur = shown.reduce((k, s, i) => (t >= s.t0 - 0.1 ? i : k), 0);
  return (
    <AbsoluteFill>
      <TitleTag seg={seg} p={ribbon} big={first} />
      <Host pose="side" f={f} style={{ left: 690, top: hostTop, width: 380, height: 600, translate: `${(1 - host) * 520}px 0px`, zIndex: 5 }} />
      <Burst text="？" color={C.blue} p={inB} style={{ left: 850, top: hostTop - 40, zIndex: 6 }} />
      {rows ? (
        <Ladder rows={rows} t={t} from={enterAt} rect={rect} />
      ) : shown.length === 0 ? (
        <div style={{ position: "absolute", left: SAFE.l, right: 380, top, height: 1290 - top, padding: "60px 40px", fontFamily: FONT, display: "flex", flexDirection: "column", justifyContent: "center", zIndex: 4, ...contentIn(local, first) }}>
          <div style={{ fontSize: 64, fontWeight: 900, color: C.deep, lineHeight: 1.3 }}>{seg.title}</div>
          <div style={{ marginTop: 30, fontSize: 30, color: C.muted }}>{seg.sourceLine}</div>
        </div>
      ) : (
        <div style={{ position: "absolute", left: SAFE.l, right: 380, top, display: "flex", flexDirection: "column", gap: 28, fontFamily: FONT, zIndex: 4 }}>
          {shown.map((s, i) => {
            const c = seg.cards?.[s.card];
            if (!c) return null;
            const col = CARD_COLORS[s.card % CARD_COLORS.length];
            // 卡片在白板里面短距离滑进来，不再从屏幕外飞进来
            const p = interpolate(t, [Math.max(s.t0 - 0.15, enterAt), Math.max(s.t0 - 0.15, enterAt) + 0.5], [0, 1], { ...clamp, easing: EASE_OUT });
            const on = i === cur;
            const fromRight = s.card % 2 === 0;
            const body = c.body.length > 40 ? 28 : 32;
            return (
              <div key={s.card} style={{ position: "relative", minHeight: 240, borderRadius: 30, padding: "24px 30px", overflow: "hidden", color: on ? "rgba(255,255,255,.14)" : col[2], background: on ? `linear-gradient(135deg,${C.blue},${C.deep})` : col[1], border: `3px solid ${on ? C.deep : col[2]}`, boxShadow: on ? "0 18px 36px rgba(31,107,255,.35)" : "0 8px 20px rgba(11,42,122,.08)", translate: `${(1 - p) * (fromRight ? 160 : -160)}px 0px`, opacity: p, filter: `blur(${(1 - p) * 8}px)`, scale: on ? "1.03" : "1" }}>
                <div style={{ position: "absolute", inset: 0, opacity: 0.55, backgroundImage: TEXTURES[s.card % 3], backgroundSize: s.card % 3 === 1 ? "18px 18px" : s.card % 3 === 2 ? "24px 24px" : undefined }} />
                <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ width: 64, height: 64, borderRadius: 18, background: "rgba(255,255,255,.92)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                    <Icon name={c.icon} color={col[0]} size={38} />
                  </div>
                  <div style={{ fontSize: 40, fontWeight: 900, color: on ? "#fff" : col[0], whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.heading}</div>
                </div>
                <div style={{ position: "relative", marginTop: 14, fontSize: body, lineHeight: 1.45, fontWeight: 600, color: on ? "#fff" : C.ink2 }}>{c.body}</div>
              </div>
            );
          })}
        </div>
      )}
    </AbsoluteFill>
  );
};

// ───────── D：一句话总结（上面大字卡，下面主持人张开双手） ─────────
const BeatD: React.FC<{ seg: Seg }> = ({ seg }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const c = seg.concl!;
  const t = f / fps - c.offset;
  const host = useSpringIn(0.05, 12);
  const card = useSpringIn(0.15, 13);
  const text = (seg.comment || "").replace(/\n/g, "");
  let lines = (seg.comment || "").includes("\n") ? seg.comment!.split("\n") : text.split(/(?<=[，、！？])/);
  // 一整句太长：从中间断成两行，字才能大
  // 优先断在「和/与/及」前面或「的/，/、」后面，离中间最近的那个；找不到才从正中间断
  if (lines.length === 1 && text.length > 9) {
    const mid = text.length / 2;
    let cut = Math.ceil(mid);
    let best = Infinity;
    [...text].forEach((ch, i) => {
      const at = "和与及".includes(ch) ? i : "的，、".includes(ch) ? i + 1 : -1;
      if (at > 2 && at < text.length - 2 && Math.abs(at - mid) < Math.min(best, text.length * 0.3)) { best = Math.abs(at - mid); cut = at; }
    });
    lines = [text.slice(0, cut), text.slice(cut)];
  }
  const longest = Math.max(...lines.map((l) => l.length));
  const size = Math.min(100, Math.floor(760 / Math.max(4, longest)));
  const shown = Math.round(interpolate(t, [c.speak.t0, c.speak.t1 - 0.2], [0, text.length], clamp));
  const stamp = spring({ frame: f - (c.offset + c.speak.t1 + 0.1) * fps, fps, config: { damping: 9, mass: 0.6 } });
  let left = shown;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: SAFE.l, right: 1080 - SAFE.r, top: 410, height: 400, borderRadius: 40, background: "#fff", border: `4px solid ${C.deep}`, boxShadow: `10px 10px 0 ${C.deep}`, fontFamily: FONT, scale: String(interpolate(card, [0, 1], [0.7, 1])), opacity: Math.min(1, card * 2), transformOrigin: "50% 100%" }}>
        <div style={{ position: "absolute", left: 40, top: -26, background: C.blue, color: "#fff", fontSize: 32, fontWeight: 900, letterSpacing: 6, padding: "8px 26px", borderRadius: 999 }}>一句话总结</div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", textAlign: "center" }}>
          {lines.map((l, i) => {
            const vis = l.slice(0, Math.max(0, left));
            left -= l.length;
            return (
              <div key={i} style={{ fontSize: size, fontWeight: 900, color: i === lines.length - 1 ? C.blue : C.ink, lineHeight: 1.3, minHeight: size * 1.3, whiteSpace: "nowrap" }}>
                {vis}
              </div>
            );
          })}
        </div>
        {seg.stamp ? <div style={{ position: "absolute", right: 30, bottom: -40, border: `8px solid ${C.red}`, color: C.red, background: "rgba(255,255,255,.85)", borderRadius: 16, padding: "4px 22px", fontSize: 64, fontWeight: 900, letterSpacing: 8, rotate: "-10deg", scale: String(interpolate(stamp, [0, 1], [2.4, 1])), opacity: Math.min(1, stamp * 2) }}>{seg.stamp}</div> : null}
        <div style={{ position: "absolute", left: 386, bottom: -46, width: 0, height: 0, borderLeft: "34px solid transparent", borderRight: "34px solid transparent", borderTop: `44px solid ${C.deep}` }} />
      </div>
      <div style={{ position: "absolute", left: 240, top: 1440, width: 600, height: 100, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(31,107,255,.3), rgba(31,107,255,0))" }} />
      <Host pose="present" mouth={c.mouth} f={f - c.offset * fps} style={{ left: 250, top: 850, width: 580, height: 640, scale: String(interpolate(host, [0, 1], [0.7, 1])), opacity: Math.min(1, host * 2), transformOrigin: "50% 100%" }} />
    </AbsoluteFill>
  );
};

// ───────── 概览：今天有哪几条（主持人右下角） ─────────
const Overview: React.FC<{ seg: Seg; ep: Episode }> = ({ seg, ep }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const host = useSpringIn(0.4, 11);
  const tag = useSpringIn(0.05, 14);
  const list = seg.list || [];
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <div style={{ position: "absolute", left: SAFE.l - 10, top: 392, display: "flex", alignItems: "center", gap: 18, padding: "16px 36px 18px 20px", borderRadius: 24, background: `linear-gradient(90deg,${C.deep},${C.blue})`, color: "#fff", rotate: "-2.5deg", translate: `${(1 - tag) * -900}px 0px`, boxShadow: "0 14px 30px rgba(11,42,122,.3)" }}>
        <div style={{ width: 84, height: 84, borderRadius: 20, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name="sparkles" color={C.blue} size={52} />
        </div>
        <div>
          <div style={{ fontSize: 60, fontWeight: 900 }}>今日要闻</div>
          <div style={{ fontSize: 28, fontWeight: 700, opacity: 0.88 }}>{ep.dateLabel} · 共 {ep.itemCount} 条</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: SAFE.l, right: 380, top: 540, display: "flex", flexDirection: "column", gap: 16 }}>
        {list.map((it, i) => {
          const p = spring({ frame: f - (0.6 + i * 0.18) * fps, fps, config: { damping: 13 } });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 20px", borderRadius: 22, background: "#fff", boxShadow: "0 10px 26px rgba(11,42,122,.1)", border: "2px solid #E1EBFC", translate: `${(1 - p) * (i % 2 ? 1200 : -1200)}px 0px`, opacity: p > 0.02 ? 1 : 0 }}>
              <div style={{ width: 50, height: 50, borderRadius: 14, background: C.ice, color: C.blue, fontFamily: NUM, fontSize: 30, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{i + 1}</div>
              {it.logo ? <Img src={it.logo} style={{ width: 42, height: 42, flex: "none" }} /> : null}
              <div style={{ fontSize: it.title.length > 14 ? 28 : 31, fontWeight: 800, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
            </div>
          );
        })}
      </div>
      <Host pose="present" mouth={seg.mouth} f={f - seg.offset * fps} style={{ left: 690, top: 600, width: 340, height: 540, translate: `${(1 - host) * 500}px 0px` }} />
    </AbsoluteFill>
  );
};

// ───────── 一条新闻：按拍放场景，字幕、配音，最后接 D ─────────
const ItemSeg: React.FC<{ seg: Seg }> = ({ seg }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beats = seg.beats || [];
  const mainLen = sec(seg.offset + seg.duration + 0.35, fps);
  const sceneOf = (b: BeatT) => (b.scene === "A" && !seg.hero ? "C" : b.scene);
  // 每拍白板的位置大小、每拍开始的时间（本条里的秒数），给大白板变形用
  // 卡片拍（有卡片、不是数字漏斗）不放白板
  const rects = beats.map((b, i) => (sceneOf(b) === "C" && !ladderRows(seg, b) && distinctCards(b).length > 0 ? null : boardRect(sceneOf(b), i === 0)));
  const starts = beats.map((b, i) => (i === 0 ? 0 : sec(seg.offset + b.t0, fps) / fps));
  return (
    <AbsoluteFill>
      {beats.length ? (
        <Sequence durationInFrames={mainLen} name="大白板">
          <Board rects={rects} starts={starts} />
        </Sequence>
      ) : null}
      {beats.map((b, i) => {
        const from = i === 0 ? 0 : sec(seg.offset + b.t0, fps);
        const to = i === beats.length - 1 ? mainLen : sec(seg.offset + beats[i + 1].t0, fps);
        const at0 = i === 0 ? -seg.offset : b.t0;
        const scene = sceneOf(b);
        return (
          <Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)} name={`拍 ${i + 1}：${scene}`}>
            {scene === "A" ? <BeatA seg={seg} beat={b} at0={at0} first={i === 0} /> : scene === "B" ? <BeatB seg={seg} beat={b} first={i === 0} /> : <BeatC seg={seg} beat={b} at0={at0} first={i === 0} />}
          </Sequence>
        );
      })}
      <Sequence durationInFrames={mainLen} name="字幕">
        <Subtitle cues={seg.cues} t={f / fps - seg.offset} />
      </Sequence>
      <Sequence from={sec(seg.offset, fps)} name="配音">
        <Audio src={staticFile(seg.audio)} />
      </Sequence>
      {seg.concl ? (
        <Sequence from={sec(seg.concl.from - seg.from, fps)} durationInFrames={sec(seg.concl.len, fps)} name="一句话总结">
          <BeatD seg={seg} />
          <Sequence from={sec(seg.concl.offset, fps)}>
            <Audio src={staticFile(seg.concl.audio)} />
          </Sequence>
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

const OutroSeg: React.FC<{ seg: Seg }> = ({ seg }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <EndCard />
      <Subtitle cues={seg.cues} t={f / fps - seg.offset} />
      <Sequence from={sec(seg.offset, fps)}>
        <Audio src={staticFile(seg.audio)} />
      </Sequence>
    </AbsoluteFill>
  );
};

export const DailyPortrait: React.FC<EpisodeProps> = ({ episode }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!episode) return null;
  const segs = episode.segments;
  const t = f / fps;
  const cur = Math.max(0, segs.findIndex((s) => t >= s.from && t < s.end));
  const curSeg = segs[cur];
  const chapters = segs.map((s) => (s.type === "intro" ? "开场" : s.type === "outro" ? "结尾" : s.tab || s.short || ""));
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Background />
      <Header chapters={chapters} current={t < episode.sting ? 0 : cur} no={curSeg?.type === "item" ? String(curSeg.no).padStart(2, "0") : "00"} total={episode.itemCount} channel={episode.channel} sub={`${episode.column} · ${episode.dateLabel}`} />
      {segs.map((s) => (
        <Sequence key={s.id} from={sec(s.from, fps)} durationInFrames={sec(s.end - s.from, fps)} name={s.type === "item" ? `${s.no}. ${s.short}` : s.type}>
          {s.type === "intro" ? (
            <>
              <Overview seg={s} ep={episode} />
              <IntroSub seg={s} />
              <Sequence from={sec(s.offset, fps)}>
                <Audio src={staticFile(s.audio)} />
              </Sequence>
            </>
          ) : s.type === "item" ? (
            <ItemSeg seg={s} />
          ) : (
            <OutroSeg seg={s} />
          )}
        </Sequence>
      ))}
      {segs.slice(1).map((s) => (
        <Sequence key={`w${s.id}`} from={sec(s.from, fps) - 8} durationInFrames={18} name="换场">
          <Wipe />
        </Sequence>
      ))}
      <Sequence from={0} durationInFrames={sec(episode.sting, fps)} name="开场">
        <Intro channel={episode.channel} sub={`${episode.column} · ${episode.dateShort}`} />
      </Sequence>
      <Sequence from={sec(episode.sting, fps) - 2} durationInFrames={10} name="咔哒">
        <Audio src={staticFile("sfx/click.wav")} />
      </Sequence>
      {episode.bgm ? (
        <Sequence from={0} name="背景音乐">
          <Audio src={staticFile(episode.bgm)} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

// 概览段的字幕（Subtitle 要本段内的时间）
const IntroSub: React.FC<{ seg: Seg }> = ({ seg }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <Subtitle cues={seg.cues} t={f / fps - seg.offset} />;
};
