// 竖屏样板的公共部件：配色、背景、顶栏、章节条、字幕胶囊、图标、换场擦除、主持人。
import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/** Channel name with its first "AI" in an accent colour; names without "AI" are shown as they are. */
export const ChannelName: React.FC<{ name: string; color: string }> = ({ name, color }) => {
  const i = name.indexOf("AI");
  if (i < 0) return <>{name}</>;
  return <>{name.slice(0, i)}<span style={{ color }}>AI</span>{name.slice(i + 2)}</>;
};

export const C = {
  blue: "#1F6BFF",
  deep: "#0B2A7A",
  navy: "#0B1A4D",
  sky: "#5AB4FF",
  ice: "#EAF2FF",
  yel: "#FFD23F",
  red: "#FF3B5C",
  ink: "#0B1630",
  ink2: "#34405C",
  muted: "#7C8AA6",
};
export const FONT =
  '"HarmonyOS Sans SC","MiSans","Source Han Sans SC","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif';
export const NUM = '"Bahnschrift","DIN Alternate",' + FONT;

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// lucide 图标（MIT）
const ICON_PATHS: Record<string, string[]> = {
  code: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  bot: ["M12 8V4H8", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"],
  coins: ["M13.744 17.736a6 6 0 1 1-7.48-7.48", "M15 6h1v4", "m6.134 14.768.866-.5 2 3.464", "M22 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0z"],
  zap: ["M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"],
  star: ["M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"],
  "user-plus": ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z", "M19 8v6", "M22 11h-6"],
  "thumbs-up": ["M7 10v12", "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"],
  sparkles: ["M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"],
};
export const Icon: React.FC<{ name: string; color: string; size: number; stroke?: number }> = ({ name, color, size, stroke = 2 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    {(ICON_PATHS[name] || ICON_PATHS.sparkles).map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

/** 背景：淡蓝渐变 + 三团慢慢漂动的光斑 + 点阵。 */
export const Background: React.FC = () => {
  const f = useCurrentFrame();
  const blob = (x: number, y: number, r: number, color: string, sp: number, ph: number) => (
    <div
      style={{
        position: "absolute",
        left: x + Math.sin(f / sp + ph) * 90 - r,
        top: y + Math.cos(f / (sp * 1.3) + ph) * 70 - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        background: `radial-gradient(closest-side, ${color}, rgba(255,255,255,0))`,
      }}
    />
  );
  return (
    <AbsoluteFill style={{ background: "linear-gradient(180deg,#F7FAFF 0%,#EAF2FF 100%)", overflow: "hidden" }}>
      {blob(980, 160, 520, "rgba(120,170,255,.35)", 70, 0)}
      {blob(80, 1150, 600, "rgba(90,180,255,.25)", 90, 2)}
      {blob(700, 1750, 460, "rgba(150,140,255,.18)", 80, 4)}
      <AbsoluteFill style={{ backgroundImage: "radial-gradient(rgba(31,107,255,.11) 1.6px, transparent 1.8px)", backgroundSize: "36px 36px" }} />
    </AbsoluteFill>
  );
};

/**
 * 手机竖屏安全区（1080×1920 画面里的坐标，按抖音、B 站真机截图量的，取最严格）：
 * - 左右：细长屏手机上抖音会放大铺满，左右各裁掉约 100px → 重要内容放在 x 120～960；
 * - 上：状态栏、返回、搜索按钮 → y 210 以下；
 * - 下：标题、简介、评论气泡 → 重要文字在 y 1440 以上；
 * - 右侧中下部（y ≥ 860）：点赞、评论那列按钮 → 文字不超过 x 860。
 * 背景、主持人身体可以伸到安全区外面，文字、卡片、主持人的脸要在里面。
 */
export const SAFE = { l: 120, r: 960, t: 210, b: 1440, rLow: 860, lowFrom: 860 };

/** 顶栏：头像（整颗头）+ 频道名 + 栏目和日期 + 本条编号；下面是 AI 声明和章节条。都在安全区里。 */
export const Header: React.FC<{ chapters: string[]; current: number; no: string; total?: number; channel?: string; sub?: string }> = ({ chapters, current, no, total = 5, channel = "My AI News", sub = "Daily AI News" }) => (
  <>
    <div style={{ position: "absolute", left: SAFE.l, right: 1080 - SAFE.r, top: SAFE.t + 4, height: 84, display: "flex", alignItems: "center", gap: 16, fontFamily: FONT }}>
      <div style={{ width: 76, height: 76, borderRadius: "50%", border: `4px solid ${C.blue}`, background: "#fff", overflow: "hidden", flex: "none" }}>
        <Img src={staticFile("host/avatar.png")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 42, fontWeight: 900, color: C.ink, letterSpacing: 1, whiteSpace: "nowrap" }}>
          <ChannelName name={channel} color={C.blue} />
        </div>
        <div style={{ fontSize: 21, color: C.muted, marginTop: 2, whiteSpace: "nowrap" }}>{sub}</div>
      </div>
      <div style={{ marginLeft: "auto", background: C.deep, color: "#fff", borderRadius: 40, padding: "8px 22px", fontSize: 28, fontWeight: 800, fontFamily: NUM, whiteSpace: "nowrap", flex: "none" }}>
        {no === "00" ? <>共 <span style={{ color: C.yel }}>{total}</span> 条</> : <>NO.<span style={{ color: C.yel }}>{no}</span>/{String(total).padStart(2, "0")}</>}
      </div>
    </div>
    <div style={{ position: "absolute", right: 1080 - SAFE.r, top: SAFE.t + 92, fontSize: 18, color: C.muted, fontFamily: FONT, letterSpacing: 1 }}>本视频含 AI 生成内容</div>
    <div style={{ position: "absolute", left: SAFE.l, right: 1080 - SAFE.r, top: SAFE.t + 120, height: 42, display: "flex", gap: 5, fontFamily: FONT }}>
      {chapters.map((c, i) => (
        <div
          key={c}
          style={{
            flex: i === 0 || i === chapters.length - 1 ? 0.62 : 1,
            minWidth: 0,
            overflow: "hidden",
            whiteSpace: "nowrap",
            borderRadius: 11,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 19,
            fontWeight: i === current ? 900 : 700,
            color: i === current ? "#fff" : i < current ? "#4C5D80" : "#8593AE",
            background: i === current ? `linear-gradient(90deg,${C.deep},${C.blue})` : i < current ? "#C9D9F8" : "#E3ECFB",
            boxShadow: i === current ? "0 6px 14px rgba(31,107,255,.3)" : "none",
          }}
        >
          {c}
        </div>
      ))}
    </div>
  </>
);

// 字幕里的数字（3倍、70%、73.7%…）标黄；型号里的数字（M3.1）不标
const markNums = (s: string) => {
  const re = /(?<![A-Za-z0-9.\-])([0-9][0-9.,]*\s*(?:%|倍|元|万|亿|毛|[KMBT](?![A-Za-z]))?)(?![A-Za-z0-9])/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(<span key={m.index} style={{ color: C.yel }}>{m[1]}</span>);
    last = m.index + m[1].length;
  }
  out.push(s.slice(last));
  return out;
};

export type Cue = { text: string; t0: number; t1: number };
/** 字幕胶囊：深蓝半透明，新的一句弹一下。t 是本段内的秒数。 */
export const Subtitle: React.FC<{ cues: Cue[]; t: number; top?: number }> = ({ cues, t, top = 1318 }) => {
  const cue = cues.find((c) => t >= c.t0 && t < c.t1);
  if (!cue) return null;
  const k = interpolate(t - cue.t0, [0, 0.12], [0.92, 1], clamp);
  // 放在安全区里：x 120～860（右边留给平台按钮），字多就缩小，再多就换行
  const n = [...cue.text].reduce((a, ch) => a + (/[\x00-\x7f]/.test(ch) ? 0.55 : 1), 0);
  const size = Math.max(34, Math.min(46, Math.floor(660 / Math.max(1, n))));
  return (
    <div style={{ position: "absolute", left: SAFE.l, right: 1080 - SAFE.rLow, top, display: "flex", justifyContent: "center", zIndex: 20 }}>
      <div
        style={{
          scale: String(k),
          background: "rgba(11,26,77,.88)",
          color: "#fff",
          borderRadius: n * size > 680 ? 28 : 999,
          padding: "10px 30px 12px",
          fontSize: size,
          fontWeight: 800,
          fontFamily: FONT,
          letterSpacing: 1,
          lineHeight: 1.3,
          textAlign: "center",
          boxShadow: "0 10px 24px rgba(11,26,77,.25)",
          whiteSpace: n * size > 680 ? "normal" : "nowrap",
        }}
      >
        {markNums(cue.text)}
      </div>
    </div>
  );
};

/** 换场：一条斜着的蓝色色带从右扫到左。 */
export const Wipe: React.FC = () => {
  const f = useCurrentFrame();
  const x = interpolate(f, [0, 16], [1300, -1900], { ...clamp, easing: Easing.bezier(0.7, 0, 0.3, 1) });
  return (
    <AbsoluteFill style={{ zIndex: 50, pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: -300, left: x, width: 1500, height: 2600, rotate: "12deg", background: `linear-gradient(90deg, ${C.sky}, ${C.blue} 30%, ${C.deep})` }} />
    </AbsoluteFill>
  );
};

/** 主持人。pose=idle 时按嘴型数组换图（0 闭嘴 / 1 半张 / 2 张开），定时眨眼；其它姿势是单张图。f 是本段内的帧号。 */
// 会说话的姿势：每个都有 -0 闭嘴、-1 半张、-2 张开、-b 眨眼 四张图
const TALKING = ["idle", "present", "lean"];
export const Host: React.FC<{ pose: "idle" | "present" | "lean" | "point" | "thumbs" | "side"; mouth?: number[]; f: number; style?: React.CSSProperties; flip?: boolean }> = ({ pose, mouth, f, style, flip }) => {
  const { fps } = useVideoConfig();
  const t = f / fps;
  const talking = TALKING.includes(pose);
  const mo = mouth ? mouth[Math.floor(t * 15)] || 0 : 0;
  const blink = (t + 1.3) % 3.7 < 0.12 && mo === 0;
  const key = !talking ? pose : blink ? `${pose}-b` : `${pose}-${mo}`;
  const all = talking ? [`${pose}-0`, `${pose}-1`, `${pose}-2`, `${pose}-b`] : [pose];
  return (
    <div style={{ position: "absolute", ...style }}>
      {all.map((k) => (
        <Img
          key={k}
          src={staticFile(`host/${k}.png`)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", objectPosition: "50% 100%", opacity: k === key ? 1 : 0, scale: flip ? "-1 1" : undefined }}
        />
      ))}
    </div>
  );
};

/** 弹簧进场的 0→1 进度。 */
export const useSpringIn = (delaySec: number, damping = 12) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - delaySec * fps, fps, config: { damping, mass: 0.8 } });
};

/** 主持人旁边的小特效：几道发散的短线 + 一个符号。 */
export const Burst: React.FC<{ text: string; color?: string; style?: React.CSSProperties; p: number }> = ({ text, color = C.red, style, p }) => (
  <div style={{ position: "absolute", width: 140, height: 140, scale: String(p), opacity: Math.min(1, p * 1.5), ...style }}>
    {[-50, -20, 10].map((a) => (
      <div key={a} style={{ position: "absolute", left: 66, top: 20, width: 8, height: 34, borderRadius: 4, background: color, rotate: `${a}deg`, transformOrigin: "50% 110px" }} />
    ))}
    <div style={{ position: "absolute", left: 40, top: 50, fontSize: 66, fontWeight: 900, color, fontFamily: FONT, WebkitTextStroke: "3px #fff", paintOrder: "stroke" }}>{text}</div>
  </div>
);
