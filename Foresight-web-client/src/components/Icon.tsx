/**
 * Inline SVG icon set — the project uses icons everywhere instead of emoji.
 * All icons are stroke-based on a 24×24 grid and inherit the current text
 * color, so they tint to match whatever button or badge they sit in. A few
 * (record / stop / bolt) are intentionally filled for emphasis.
 */
import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "camera"
  | "eye"
  | "mic"
  | "flashlight"
  | "record"
  | "stop"
  | "edit"
  | "trash"
  | "volume"
  | "volumeOff"
  | "battery"
  | "bolt"
  | "thermometer"
  | "arrowLeft"
  | "check"
  | "plus"
  | "chevronRight"
  | "settings"
  | "signOut"
  | "expand"
  | "compress"
  | "film"
  | "play"
  | "download"
  | "lock"
  | "shield"
  | "shieldAlert"
  | "help";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  title?: string;
}

export function Icon({ name, size = 18, title, ...rest }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}

const PATHS: Record<IconName, ReactElement> = {
  camera: (
    <>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.1a1 1 0 0 0 .83-.45l.74-1.1A1 1 0 0 1 9 4h6a1 1 0 0 1 .83.45l.74 1.1A1 1 0 0 0 17.4 6h1.1A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
      <circle cx="12" cy="12.3" r="3.1" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S5.7 5.8 12 5.8 21.5 12 21.5 12 18.3 18.2 12 18.2 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.9" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="8.5" y1="21" x2="15.5" y2="21" />
    </>
  ),
  flashlight: (
    <>
      <path d="M6 3h12l-1.18 5.12a2 2 0 0 1-.62 1.04L14 11v9a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-9L7.8 9.16a2 2 0 0 1-.62-1.04Z" />
      <line x1="10.5" y1="14" x2="13.5" y2="14" />
    </>
  ),
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  stop: (
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
  ),
  edit: (
    <>
      <path d="M3.5 20.5h3.6L18 9.6a2.05 2.05 0 0 0 0-2.9l-.7-.7a2.05 2.05 0 0 0-2.9 0L3.5 16.9Z" />
      <line x1="13.8" y1="6.4" x2="17.6" y2="10.2" />
    </>
  ),
  trash: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <path d="M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7" />
      <path d="M6.2 7l.9 12.1A1.5 1.5 0 0 0 8.6 20.5h6.8a1.5 1.5 0 0 0 1.5-1.4L17.8 7" />
      <line x1="10" y1="11" x2="10" y2="16.5" />
      <line x1="14" y1="11" x2="14" y2="16.5" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9.5v5h3.4L13 19V5l-5.6 4.5Z" />
      <path d="M16.2 8.8a4.2 4.2 0 0 1 0 6.4" />
      <path d="M18.7 6.3a7.7 7.7 0 0 1 0 11.4" />
    </>
  ),
  volumeOff: (
    <>
      <path d="M4 9.5v5h3.4L13 19V5l-5.6 4.5Z" />
      <line x1="16.5" y1="9.5" x2="21" y2="14.5" />
      <line x1="21" y1="9.5" x2="16.5" y2="14.5" />
    </>
  ),
  battery: (
    <>
      <rect x="2.5" y="8" width="16.5" height="8" rx="2.2" />
      <line x1="21.3" y1="11" x2="21.3" y2="13" />
    </>
  ),
  bolt: (
    <path
      d="M13 2.5 4.5 13.8H10l-1 7.7 9-11.8H12.4Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  thermometer: (
    <>
      <path d="M14 14.8V5.5a2 2 0 0 0-4 0v9.3a4 4 0 1 0 4 0Z" />
      <line x1="12" y1="9.5" x2="12" y2="15.2" />
    </>
  ),
  arrowLeft: (
    <>
      <line x1="20" y1="12" x2="5" y2="12" />
      <path d="M11 6 5 12l6 6" />
    </>
  ),
  check: <path d="M5 12.5 10 17.5 19.5 7" />,
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.18-.33 1.65 1.65 0 0 0-1 1.51V20a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-2.18 1.65 1.65 0 0 0-1.51-1H4a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 8.04 4.6l.06.06a1.65 1.65 0 0 0 2.18.33h.08a1.65 1.65 0 0 0 1-1.51V4a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 2.18V13a1.65 1.65 0 0 0 1.51 1H20a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),
  signOut: (
    <>
      <path d="M14 5.5h3.5A1.5 1.5 0 0 1 19 7v10a1.5 1.5 0 0 1-1.5 1.5H14" />
      <path d="M10 8.5 6.5 12 10 15.5" />
      <line x1="6.5" y1="12" x2="15" y2="12" />
    </>
  ),
  expand: (
    <>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </>
  ),
  compress: (
    <>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="10" y1="14" x2="3" y2="21" />
      <line x1="21" y1="3" x2="14" y2="10" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <line x1="3" y1="9.5" x2="21" y2="9.5" />
      <line x1="3" y1="14.5" x2="21" y2="14.5" />
      <line x1="8" y1="4.5" x2="8" y2="19.5" />
      <line x1="16" y1="4.5" x2="16" y2="19.5" />
    </>
  ),
  play: (
    <path
      d="M8 5.4a.6.6 0 0 1 .92-.5l10.2 6.6a.6.6 0 0 1 0 1l-10.2 6.6A.6.6 0 0 1 8 18.6Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  download: (
    <>
      <line x1="12" y1="4" x2="12" y2="14.5" />
      <path d="M8 10.5 12 14.5 16 10.5" />
      <line x1="5" y1="19.5" x2="19" y2="19.5" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </>
  ),
  shield: (
    <path d="M12 3.2 19 6v5.4c0 4.3-2.9 7.6-7 9.4-4.1-1.8-7-5.1-7-9.4V6Z" />
  ),
  shieldAlert: (
    <>
      <path d="M12 3.2 19 6v5.4c0 4.3-2.9 7.6-7 9.4-4.1-1.8-7-5.1-7-9.4V6Z" />
      <line x1="12" y1="8.5" x2="12" y2="12.5" />
      <line x1="12" y1="15.4" x2="12" y2="15.6" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6" />
      <line x1="12" y1="16.9" x2="12" y2="17.1" />
    </>
  ),
};
