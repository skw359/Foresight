/**
 * Shares the TopBar's loading bar with the route pages.
 *
 * The bar itself lives inside the TopBar so it can sit on the header's bottom
 * edge, but pages anywhere below need to drive it. The provider holds the ref
 * to the live <NavProgress>; the TopBar binds it via `useNavProgressRef()`, and
 * pages call `start()` / `finish()` through `useNavProgress()` (or the
 * `useNavProgressWhileLoading` bridge) without threading refs by hand.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import type { NavProgressHandle } from "../components/NavProgress";

interface NavProgressContextValue {
  /** Bound by the TopBar to the live <NavProgress> element. */
  barRef: RefObject<NavProgressHandle | null>;
  /** Stable methods pages call directly; no-ops until the bar mounts. */
  start: () => void;
  finish: () => void;
}

const NavProgressContext = createContext<NavProgressContextValue | null>(null);

export function NavProgressProvider({ children }: { children: ReactNode }) {
  const barRef = useRef<NavProgressHandle>(null);
  // Track whether the bar is currently running so a second start() from a
  // newly-mounted page doesn't reset it back to 0 mid-flight.
  const running = useRef(false);
  const value = useMemo<NavProgressContextValue>(
    () => ({
      barRef,
      start: () => {
        if (running.current) return;
        running.current = true;
        barRef.current?.start();
      },
      finish: () => {
        running.current = false;
        barRef.current?.finish();
      },
    }),
    [],
  );
  return (
    <NavProgressContext.Provider value={value}>
      {children}
    </NavProgressContext.Provider>
  );
}

const NOOP = { start: () => {}, finish: () => {} };

/** Page-facing API: imperatively drive the top loading bar. */
export function useNavProgress(): Pick<
  NavProgressContextValue,
  "start" | "finish"
> {
  return useContext(NavProgressContext) ?? NOOP;
}

/** TopBar-facing API: the ref to bind to the <NavProgress> element. */
export function useNavProgressRef(): RefObject<NavProgressHandle | null> {
  const ctx = useContext(NavProgressContext);
  if (!ctx) {
    throw new Error("useNavProgressRef must be used within a NavProgressProvider");
  }
  return ctx.barRef;
}

/**
 * Convenience bridge for pages whose load is a boolean: shows the bar while
 * `loading` is true and finishes it when it flips false. If the page unmounts
 * mid-load the bar is left running — the next page's start() takes it over, so
 * the strip flows continuously across navigation.
 */
export function useNavProgressWhileLoading(loading: boolean) {
  const { start, finish } = useNavProgress();
  const active = useRef(false);
  useEffect(() => {
    if (loading && !active.current) {
      active.current = true;
      start();
    } else if (!loading && active.current) {
      active.current = false;
      finish();
    }
  }, [loading, start, finish]);
}
