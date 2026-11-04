/*
 * Homes list + navigation into a Home's camera grid. Supports create-home,
 * pull-to-refresh, settings, and an empty state. Port of iOS HomesListView.
 * Navigation is state-driven: Homes → Grid (Back returns).
 */
package com.foresight.viewer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.foresight.viewer.contract.HomeDTO
import com.foresight.viewer.network.ApiException
import com.foresight.viewer.session.Session
import com.foresight.viewer.support.AppConfig
import kotlinx.coroutines.launch

@Composable
fun HomesNav(session: Session, config: AppConfig) {
    var selectedHome by remember { mutableStateOf<HomeDTO?>(null) }

    val home = selectedHome
    if (home == null) {
        HomesScreen(session = session, config = config, onOpenHome = { selectedHome = it })
    } else {
        BackHandler { selectedHome = null }
        HomeGridScreen(
            session = session,
            home = home,
            onBack = { selectedHome = null },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomesScreen(session: Session, config: AppConfig, onOpenHome: (HomeDTO) -> Unit) {
    var homes by remember { mutableStateOf<List<HomeDTO>>(emptyList()) }
    var isLoading by remember { mutableStateOf(false) }
    var didLoad by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    var showCreate by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        isLoading = true
        errorMessage = null
        try {
            homes = session.api.listHomes()
        } catch (e: Exception) {
            if ((e as? ApiException)?.status == 401) {
                session.sessionExpired()
                return
            }
            errorMessage = e.message ?: "Could not load Homes."
        }
        isLoading = false
        didLoad = true
    }

    LaunchedEffect(Unit) { load() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Homes") },
                navigationIcon = {
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                },
                actions = {
                    IconButton(onClick = { showCreate = true }) {
                        Icon(Icons.Filled.Add, contentDescription = "Add Home")
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = isLoading && didLoad,
            onRefresh = { scope.launch { load() } },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            when {
                isLoading && homes.isEmpty() && !didLoad -> {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator()
                            Text(
                                "Loading Homes…",
                                modifier = Modifier.padding(top = 12.dp),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }

                homes.isEmpty() && didLoad -> EmptyHomes(onCreate = { showCreate = true })

                else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
                    errorMessage?.let { error ->
                        item {
                            Text(
                                error,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.padding(16.dp),
                            )
                        }
                    }
                    items(homes, key = { it.id }) { home ->
                        HomeRow(home = home, onClick = { onOpenHome(home) })
                        HorizontalDivider()
                    }
                }
            }
        }
    }

    if (showSettings) {
        SettingsSheet(session = session, config = config, onDismiss = { showSettings = false })
    }
    if (showCreate) {
        CreateHomeDialog(
            onDismiss = { showCreate = false },
            onCreate = { name ->
                try {
                    val home = session.api.createHome(name)
                    homes = listOf(home) + homes
                    true
                } catch (e: Exception) {
                    errorMessage = e.message ?: "Could not create the Home."
                    false
                }
            },
        )
    }
}

@Composable
private fun HomeRow(home: HomeDTO, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Home,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(28.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(home.name, style = MaterialTheme.typography.titleMedium)
            Text(
                home.role.wireName.replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if ((home.keyEpoch ?: 0) >= 1) {
            Icon(
                Icons.Filled.Lock,
                contentDescription = "End-to-end encrypted",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun EmptyHomes(onCreate: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.padding(32.dp),
        ) {
            Icon(
                Icons.Filled.Home,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(44.dp),
            )
            Text("No Homes Yet", style = MaterialTheme.typography.titleLarge)
            Text(
                "Create a Home to start adding cameras.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onCreate) { Text("Create Home") }
        }
    }
}

@Composable
private fun CreateHomeDialog(onDismiss: () -> Unit, onCreate: suspend (String) -> Boolean) {
    var name by remember { mutableStateOf("") }
    var isSubmitting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    AlertDialog(
        onDismissRequest = { if (!isSubmitting) onDismiss() },
        title = { Text("New Home") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Home name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = {
                    isSubmitting = true
                    scope.launch {
                        if (onCreate(name.trim())) onDismiss()
                        isSubmitting = false
                    }
                },
                enabled = name.trim().isNotEmpty() && !isSubmitting,
            ) { Text("Create") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSubmitting) { Text("Cancel") }
        },
    )
}
