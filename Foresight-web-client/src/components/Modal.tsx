/**
 * Lightweight modal dialog. The blurred backdrop and dialog fade in on mount
 * and fade out over 0.25s before unmounting (opacity only — no scale). Closes
 * on backdrop click and Escape.
 *
 * Because closing is animated, children that need to dismiss the modal (Cancel
 * / Done buttons, etc.) should use the `close` callback handed to them via the
 * render-prop form, so those paths animate out too:
 *
 *   <Modal title="…" onClose={onClose}>
 *     {(close) => <button onClick={close}>Cancel</button>}
 *   </Modal>
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
  wide?: boolean;
}

const FADE_MS = 250;

export function Modal({ title, onClose, children, wide }: ModalProps) {
  const [open, setOpen] = useState(false);
  const closing = useRef(false);

  // Fade in on the frame after mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Blur the page content (including <video> elements) while the modal is
  // open. backdrop-filter can't blur video compositor layers, so we apply
  // filter: blur() to .app-shell instead. The class is toggled in sync with
  // the open state so the CSS transition matches the modal fade.
  useEffect(() => {
    document.body.classList.toggle("modal-open", open);
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  // Fade out, then unmount via the parent's onClose.
  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setOpen(false);
    window.setTimeout(onClose, FADE_MS);
  }, [onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  return createPortal(
    <div
      className={`modal-backdrop${open ? " open" : ""}`}
      onMouseDown={requestClose}
    >
      <div
        className={`modal${wide ? " wide" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2>{title}</h2>
        {typeof children === "function" ? children(requestClose) : children}
      </div>
    </div>,
    document.body,
  );
}
