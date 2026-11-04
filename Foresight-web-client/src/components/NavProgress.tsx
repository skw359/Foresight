/**
 * Top-of-page loading bar — a glowing orange strip pinned to the bottom edge of
 * the TopBar, shown while a page loads its data on navigation.
 *
 * Pages drive it imperatively through the ref (see context/navProgress):
 *
 *   start()  — reveal + dash to 70% in 0.5s, then crawl to 85% over 15s
 *   finish() — snap to 100%, then fade out over 0.4s
 *
 * The bar is scaled with `transform: scaleX()` (transform-origin: left) rather
 * than animating `width`, so the growth is GPU-composited and stays smooth. The
 * animation is run by mutating the bar element's style directly rather than
 * through React state, so each phase cleanly overrides the previous CSS
 * transition (e.g. the 0.5s dash, then the 15s crawl) without re-render timing
 * getting in the way. Only the static look (orange fill, glow) lives in
 * styles.css under `.nav-progress`.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface NavProgressHandle {
  /** Reveal the bar and animate toward 85% while work is in flight. */
  start(): void;
  /** Complete to 100% and fade out. */
  finish(): void;
}

export const NavProgress = forwardRef<NavProgressHandle>(function NavProgress(
  _props,
  ref,
) {
  const barRef = useRef<HTMLDivElement>(null);
  // Pending phase / cleanup timers, cleared whenever a new phase begins so a
  // fresh start() during an in-flight finish() (rapid navigation) stays clean.
  const timers = useRef<number[]>([]);
  // The pending phase-1 rAF, tracked so a new phase can cancel it cleanly.
  const raf = useRef<number | null>(null);

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    if (raf.current !== null) {
      window.cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      start() {
        const el = barRef.current;
        if (!el) return;
        clearTimers();
        // Reset to 0 with no transition, then kick off the grow on the next
        // frame so the browser keeps the reset and the grow as two distinct
        // steps (not one skipped one).
        el.style.transition = "none";
        el.style.transform = "scaleX(0)";
        el.style.opacity = "1";
        raf.current = window.requestAnimationFrame(() => {
          raf.current = null;
          // Phase 1 — sweep to 70% in 0.5s. The easing must NOT be front-loaded
          // (e.g. ease-out / expo curves cross 25% within ~40ms, so the bar
          // looks like it pops in a quarter of the way through). This curve
          // starts at zero velocity, so the 0 → 70% travel is actually visible.
          el.style.transition = "transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)";
          el.style.transform = "scaleX(0.70)";
        });
        // Phase 2 — slow crawl to 85% over the next 15s.
        timers.current.push(
          window.setTimeout(() => {
            el.style.transition = "transform 15s linear";
            el.style.transform = "scaleX(0.85)";
          }, 500),
        );
      },
      finish() {
        const el = barRef.current;
        if (!el) return;
        clearTimers();
        // Snap to 100%…
        el.style.transition = "transform 0.1s ease-in";
        el.style.transform = "scaleX(1)";
        // …then fade the full bar out, and reset it once it's invisible so the
        // next start() begins cleanly at 0.
        timers.current.push(
          window.setTimeout(() => {
            el.style.transition = "opacity 0.4s ease-out";
            el.style.opacity = "0";
            timers.current.push(
              window.setTimeout(() => {
                el.style.transition = "none";
                el.style.transform = "scaleX(0)";
              }, 500),
            );
          }, 100),
        );
      },
    }),
    [],
  );

  // Drop any pending timers if the header unmounts mid-animation.
  useEffect(() => () => clearTimers(), []);

  return (
    <div className="nav-progress" aria-hidden="true">
      <div className="nav-progress-bar" ref={barRef} />
    </div>
  );
});
