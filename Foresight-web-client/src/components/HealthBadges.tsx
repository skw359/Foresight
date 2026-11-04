/**
 * Health badges for a camera: online, battery, charging, Wi-Fi bars, thermal
 * warning. Driven entirely by live telemetry (with REST fallback) — nothing
 * hardcoded.
 */
import type { ThermalState, WifiInfo } from "@foresight/contract";

import { Icon } from "./Icon";

interface HealthBadgesProps {
  battery: number | null;
  charging: boolean | null;
  wifi: WifiInfo | null;
  thermal: ThermalState | null;
  compact?: boolean;
}

export function HealthBadges({
  battery,
  charging,
  wifi,
  thermal,
}: HealthBadgesProps) {
  const hasBattery = battery !== null;
  const hasWifi = !!wifi;
  const hasThermal = !!thermal && thermal !== "nominal";
  if (!hasBattery && !hasWifi && !hasThermal) return null;

  const sep = <span style={{ opacity: 0.4, margin: "0 2px" }}>·</span>;

  return (
    <div className="badges">
      <span
        className={`badge ${hasBattery ? batteryClass(battery!, charging) : ""}`}
        style={{ borderRadius: "10px" }}
        title={[
          hasWifi ? wifiTitle(wifi!) : "",
          hasBattery ? `Battery ${Math.round(battery! * 100)}%${charging ? " · Charging" : ""}` : "",
          hasThermal ? thermalLabel(thermal!) : "",
        ].filter(Boolean).join(" · ")}
      >
        {hasWifi && <WifiBars level={wifi!.level} />}
        {hasWifi && hasBattery && sep}
        {hasBattery && (
          <>
            <Icon name={charging ? "bolt" : "battery"} size={14} />
            {Math.round(battery! * 100)}%
          </>
        )}
        {(hasWifi || hasBattery) && hasThermal && sep}
        {hasThermal && (
          <>
            <Icon name="thermometer" size={14} /> {thermalLabel(thermal!)}
          </>
        )}
      </span>
    </div>
  );
}

function batteryClass(battery: number, charging: boolean | null): string {
  if (charging) return "ok";
  if (battery <= 0.1) return "crit";
  if (battery <= 0.25) return "warn";
  return "";
}


function thermalLabel(t: ThermalState): string {
  switch (t) {
    case "fair":
      return "Warm";
    case "serious":
      return "Hot";
    case "critical":
      return "Critical";
    default:
      return "Nominal";
  }
}

function wifiTitle(wifi: WifiInfo): string {
  const parts = [`Wi-Fi ${wifi.level}/4`];
  if (wifi.ssid) parts.push(wifi.ssid);
  if (typeof wifi.rssi === "number") parts.push(`${wifi.rssi} dBm`);
  return parts.join(" · ");
}

/** Four-bar Wi-Fi strength indicator (0–4). */
export function WifiBars({ level }: { level: number }) {
  const clamped = Math.max(0, Math.min(4, Math.round(level)));
  const heights = [4, 6, 8, 11];
  return (
    <span className="wifi-bars" aria-label={`Wi-Fi ${clamped} of 4`}>
      {heights.map((h, i) => (
        <i
          key={i}
          className={i < clamped ? "on" : ""}
          style={{ height: `${h}px` }}
        />
      ))}
    </span>
  );
}
