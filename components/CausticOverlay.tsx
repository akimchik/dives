"use client";

const RAYS = [
  { left: "5%",  w: 90,  dur: 8.2,  delay: 0,    amp: 28, opLo: 0.10, opHi: 0.26 },
  { left: "17%", w: 42,  dur: 5.8,  delay: -2.1, amp: 16, opLo: 0.07, opHi: 0.18 },
  { left: "29%", w: 110, dur: 10.0, delay: -4.3, amp: 34, opLo: 0.13, opHi: 0.29 },
  { left: "45%", w: 58,  dur: 6.8,  delay: -1.5, amp: 20, opLo: 0.09, opHi: 0.21 },
  { left: "59%", w: 96,  dur: 9.1,  delay: -3.4, amp: 30, opLo: 0.12, opHi: 0.27 },
  { left: "73%", w: 48,  dur: 6.3,  delay: -5.2, amp: 14, opLo: 0.07, opHi: 0.17 },
  { left: "84%", w: 76,  dur: 7.7,  delay: -2.6, amp: 24, opLo: 0.10, opHi: 0.23 },
];

export function CausticOverlay() {
  const keyframes = RAYS.map((r, i) => `
    @keyframes sway-${i} {
      0%   { transform: translateX(0px)          skewX(0deg);    opacity: ${r.opLo}; }
      25%  { transform: translateX(${r.amp}px)   skewX(-1.8deg); opacity: ${r.opHi}; }
      55%  { transform: translateX(${-r.amp * 0.7}px) skewX(1.4deg); opacity: ${(r.opLo + r.opHi) / 2}; }
      78%  { transform: translateX(${r.amp * 0.4}px) skewX(-0.8deg); opacity: ${r.opHi * 0.85}; }
      100% { transform: translateX(0px)          skewX(0deg);    opacity: ${r.opLo}; }
    }
  `).join("\n");

  return (
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 6 }}
    >
      <style>{keyframes}</style>

      {RAYS.map((r, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: r.left,
            width: r.w,
            background: `linear-gradient(to right,
              transparent 0%,
              rgba(148, 218, 245, ${r.opLo * 0.6}) 25%,
              rgba(180, 235, 255, ${r.opHi}) 50%,
              rgba(148, 218, 245, ${r.opLo * 0.6}) 75%,
              transparent 100%
            )`,
            mixBlendMode: "screen",
            maskImage:
              "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.6) 4%, black 12%, black 55%, rgba(0,0,0,0.3) 72%, transparent 88%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.6) 4%, black 12%, black 55%, rgba(0,0,0,0.3) 72%, transparent 88%)",
            animation: `sway-${i} ${r.dur}s ease-in-out infinite ${r.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
