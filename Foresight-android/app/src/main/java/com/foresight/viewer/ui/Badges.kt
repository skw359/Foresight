/*
 * Reusable badges for camera health: online, battery, charging, Wi-Fi, thermal,
 * viewer count. Driven by LiveCamera's realtime telemetry. Port of the iOS
 * HealthBadges.
 */
package com.foresight.viewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.BatteryFull
import androidx.compose.material.icons.filled.Battery0Bar
import androidx.compose.material.icons.filled.Battery2Bar
import androidx.compose.material.icons.filled.Battery4Bar
import androidx.compose.material.icons.filled.Battery6Bar
import androidx.compose.material.icons.filled.DeviceThermostat
import androidx.compose.material.icons.filled.SignalWifi4Bar
import androidx.compose.material.icons.filled.SignalWifiStatusbarConnectedNoInternet4
import androidx.compose.material.icons.filled.SignalWifiOff
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.foresight.viewer.contract.ThermalState
import com.foresight.viewer.contract.WifiInfo
import com.foresight.viewer.realtime.LiveCamera

@Composable
fun OnlineDot(online: Boolean, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Box(
        modifier = modifier
            .size(9.dp)
            .background(if (online) Color(0xFF34C759) else Color.Gray, CircleShape),
    )
}

@Composable
fun RecordingDot(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .background(Color.Black.copy(alpha = 0.45f), MaterialTheme.shapes.small)
            .padding(horizontal = 6.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.foundation.layout.Box(
            modifier = Modifier.size(8.dp).background(Color.Red, CircleShape),
        )
        Text("REC", style = MaterialTheme.typography.labelSmall, color = Color.White)
    }
}

@Composable
fun BatteryBadge(level: Double?, charging: Boolean?) {
    val icon = when {
        charging == true -> Icons.Filled.BatteryChargingFull
        level == null -> Icons.Filled.Battery0Bar
        level < 0.13 -> Icons.Filled.Battery0Bar
        level < 0.38 -> Icons.Filled.Battery2Bar
        level < 0.63 -> Icons.Filled.Battery4Bar
        level < 0.88 -> Icons.Filled.Battery6Bar
        else -> Icons.Filled.BatteryFull
    }
    val tint = when {
        charging == true -> Color(0xFF34C759)
        level == null -> Color.White.copy(alpha = 0.6f)
        level < 0.15 -> Color(0xFFFF453A)
        else -> Color.White
    }
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = "Battery", tint = tint, modifier = Modifier.size(14.dp))
        level?.let {
            Text(
                "${(it * 100).toInt()}%",
                style = MaterialTheme.typography.labelSmall,
                color = tint,
            )
        }
    }
}

@Composable
fun WifiBadge(wifi: WifiInfo?) {
    val level = wifi?.level ?: 0
    val (icon, tint) = when {
        level < 1 -> Icons.Filled.SignalWifiOff to Color(0xFFFF9F0A)
        level == 1 -> Icons.Filled.SignalWifiStatusbarConnectedNoInternet4 to Color(0xFFFF9F0A)
        else -> Icons.Filled.SignalWifi4Bar to Color.White
    }
    Icon(icon, contentDescription = "Wi-Fi signal $level of 4", tint = tint, modifier = Modifier.size(14.dp))
}

@Composable
fun ThermalBadge(thermal: ThermalState?) {
    if (thermal == null || thermal == ThermalState.NOMINAL) return
    val tint = when (thermal) {
        ThermalState.NOMINAL -> Color.White.copy(alpha = 0.6f)
        ThermalState.FAIR -> Color(0xFFFFD60A)
        ThermalState.SERIOUS -> Color(0xFFFF9F0A)
        ThermalState.CRITICAL -> Color(0xFFFF453A)
    }
    Icon(
        Icons.Filled.DeviceThermostat,
        contentDescription = "Thermal ${thermal.name.lowercase()}",
        tint = tint,
        modifier = Modifier.size(14.dp),
    )
}

@Composable
fun ViewerCountBadge(count: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            Icons.Filled.Visibility,
            contentDescription = "$count viewers",
            tint = Color.White,
            modifier = Modifier.size(13.dp),
        )
        Text("$count", style = MaterialTheme.typography.labelSmall, color = Color.White)
    }
}

/** Compact horizontal strip of health badges for a tile or the full-screen HUD. */
@Composable
fun HealthStrip(camera: LiveCamera, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BatteryBadge(level = camera.battery, charging = camera.charging)
        WifiBadge(wifi = camera.wifi)
        ThermalBadge(thermal = camera.thermal)
        Spacer(Modifier.weight(1f))
        ViewerCountBadge(count = camera.viewerCount)
    }
}
