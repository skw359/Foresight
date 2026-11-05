import { useEffect, useRef } from "react";

/**
 * Animated visual for the auth screen: a glowing accent-colored line that
 * draws itself across a faint grid. Purely decorative (aria-hidden via the
 * wrapper); honors prefers-reduced-motion by snapping to the final frame.
 */

const ACCENT = "#ff634a";
const GRID_COLOR = "rgba(255, 99, 74, 0.07)";
const GRID_STEP = 80;
const DURATION = 1400;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function buildPathD(W: number, H: number): string {
  return [
    `M ${W * 0.18} ${H * 0.92}`,
    `C ${W * 0.26} ${H * 0.92} ${W * 0.38} ${H * 0.54} ${W * 0.52} ${H * 0.6}`,
    `C ${W * 0.63} ${H * 0.65} ${W * 0.73} ${H * 0.6} ${W * 1.06} ${H * 0.62}`,
  ].join(" ");
}

function measurePathLength(W: number, H: number): number {
  const el = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  el.setAttribute("d", buildPathD(W, H));
  return el.getTotalLength();
}

export default function VisualCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animFrame = 0;
    let startTime: number | null = null;
    let currentProgress = 0;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let totalLength = 0;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      totalLength = measurePathLength(W, H);
    };

    const drawCurve = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      ctx.moveTo(W * 0.18, H * 0.92);
      ctx.bezierCurveTo(W * 0.26, H * 0.92, W * 0.38, H * 0.54, W * 0.52, H * 0.6);
      ctx.bezierCurveTo(W * 0.63, H * 0.65, W * 0.73, H * 0.6, W * 1.06, H * 0.62);
    };

    const draw = (progress: number) => {
      if (!W || !H) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      for (let x = GRID_STEP; x < W; x += GRID_STEP) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = GRID_STEP; y < H; y += GRID_STEP) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }

      // Glow passes — same lineDash offset drives all three in sync
      const offset = totalLength * (1 - progress);
      const passes = [
        { lineWidth: 18, alpha: 0.08, shadowBlur: 40 },
        { lineWidth: 6, alpha: 0.25, shadowBlur: 20 },
        { lineWidth: 2.5, alpha: 1, shadowBlur: 8 },
      ];

      for (const pass of passes) {
        ctx.save();
        ctx.strokeStyle = ACCENT;
        ctx.shadowColor = ACCENT;
        ctx.lineWidth = pass.lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = pass.alpha;
        ctx.shadowBlur = pass.shadowBlur;
        ctx.setLineDash([totalLength]);
        ctx.lineDashOffset = offset;
        drawCurve(ctx);
        ctx.stroke();
        ctx.restore();
      }
    };

    const animate = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const raw = Math.min((timestamp - startTime) / DURATION, 1);
      currentProgress = easeOutCubic(raw);
      draw(currentProgress);
      if (raw < 1) animFrame = requestAnimationFrame(animate);
    };

    resize();
    if (reduceMotion) {
      currentProgress = 1;
      draw(1);
    } else {
      animFrame = requestAnimationFrame(animate);
    }

    const ro = new ResizeObserver(() => {
      resize();
      draw(currentProgress);
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(animFrame);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "block",
        pointerEvents: "none",
      }}
    />
  );
}
