/*
 * Configurable API base URL (default http://10.0.2.2:3199, which reaches the
 * host machine from the Android emulator). On a physical device set it to the
 * host's LAN IP. Includes Sign Out when authenticated. Port of iOS SettingsView.
 */
package com.foresight.viewer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.foresight.viewer.session.Session
import com.foresight.viewer.support.AppConfig
import kotlinx.coroutines.launch

@Composable
fun SettingsSheet(session: Session, config: AppConfig, onDismiss: () -> Unit) {
    var draft by remember { mutableStateOf(config.resolveBaseUrl()) }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Settings") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("API Base URL", style = MaterialTheme.typography.labelLarge)
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    placeholder = { Text(AppConfig.DEFAULT_BASE_URL) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "The Foresight backend address. The default reaches the host machine " +
                        "from the Android emulator. On a real device, use the host's LAN IP " +
                        "(e.g. http://192.168.1.20:3199).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    OutlinedButton(onClick = { draft = AppConfig.DEFAULT_BASE_URL }) {
                        Text("Reset to Default")
                    }
                    if (session.isAuthenticated) {
                        OutlinedButton(
                            onClick = {
                                scope.launch {
                                    session.signOut()
                                    onDismiss()
                                }
                            },
                        ) {
                            Text("Sign Out", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val trimmed = draft.trim()
                config.setBaseUrl(trimmed.ifEmpty { AppConfig.DEFAULT_BASE_URL })
                onDismiss()
            }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
