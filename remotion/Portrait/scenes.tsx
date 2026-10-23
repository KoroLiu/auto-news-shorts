// Intro and end card of a vertical episode (the story scenes live in Episode.tsx).
import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, ChannelName, clamp, FONT, Host, Icon, useSpringIn } from "./common";

export type Beat = {
  scene: string;
  audio: string;
  duration: number;
  mouth: number[];
  cues: { text: string; t0: number; t1: number }[];
  sentences: { card: number; t0: number; t1: number }[];
};
export type Card = { icon: string; heading: string; body: string };

export const Intro: React.FC<{ channel?: string; sub?: string }> = ({ channel = "My AI News", sub = "Daily AI News" }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: f, fps, config: { damping: 12 } });
  const out = interpolate(f, [1.25 * fps, 1.6 * fps], [0, 1], { ...clamp, easing: Easing.bezier(0.7, 0, 0.3, 1) });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${C.deep}, ${C.blue})`, translate: `0px ${-out * 1920}px`, zIndex: 60, alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
      <div style={{ width: 300, height: 300, borderRadius: "50%", background: "#fff", border: "10px solid #fff", overflow: "hidden", scale: String(p), boxShadow: "0 20px 50px rgba(0,0,0,.25)" }}>
        <Img src={staticFile("host/avatar.png")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      <div style={{ marginTop: 40, fontSize: 96, fontWeight: 900, color: "#fff", letterSpacing: 4, translate: `0px ${(1 - p) * 80}px`, opacity: p }}>
        <ChannelName name={channel} color={C.yel} />
      </div>
      <div style={{ marginTop: 16, fontSize: 40, color: "rgba(255,255,255,.85)", letterSpacing: 6, opacity: p }}>{sub}</div>
    </AbsoluteFill>
  );
};

// ───────── 结尾：主持人比赞 + 点赞 / 投币 / 收藏 / 关注 依次亮起 ─────────
export const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const host = useSpringIn(0.05, 11);
  const btns: [string, string][] = [["thumbs-up", "点赞"], ["coins", "投币"], ["star", "收藏"], ["user-plus", "关注"]];
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <Host pose="thumbs" f={f} style={{ left: 60, top: 560, width: 480, height: 820, scale: String(interpolate(host, [0, 1], [0.5, 1])), transformOrigin: "50% 100%" }} />
      <div style={{ position: "absolute", left: 540, right: 220, top: 520 }}>
        <div style={{ fontSize: 52, fontWeight: 900, color: C.ink, lineHeight: 1.25, whiteSpace: "nowrap" }}>觉得有用的话</div>
        <div style={{ fontSize: 40, fontWeight: 700, color: C.muted, marginTop: 8 }}>我们明天见～</div>
        <div style={{ marginTop: 50, display: "flex", flexDirection: "column", gap: 26 }}>
          {btns.map(([ic, label], i) => {
            const p = spring({ frame: f - (0.5 + i * 0.35) * fps, fps, config: { damping: 9 } });
            const lit = p > 0.6;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 20, padding: "14px 26px", borderRadius: 999, width: 300, background: lit ? `linear-gradient(90deg,${C.blue},${C.deep})` : "#fff", border: `3px solid ${lit ? C.deep : "#D3E2FB"}`, scale: String(interpolate(p, [0, 1], [0.6, 1])), opacity: Math.min(1, p * 2), boxShadow: lit ? "0 12px 26px rgba(31,107,255,.3)" : "none" }}>
                <Icon name={ic} color={lit ? "#fff" : C.blue} size={50} stroke={2.4} />
                <span style={{ fontSize: 46, fontWeight: 900, color: lit ? "#fff" : C.ink }}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
