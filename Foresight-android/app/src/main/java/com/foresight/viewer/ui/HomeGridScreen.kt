/*
 * Camera grid for one Home. Connects to the Home's LiveKit room via a viewer
 * rt token, renders tiles with live video + health badges, polls the REST
 * registry (~10 s) so newly-paired cameras appear, and surfaces the connection
 * banners: connecting / failed / locked (E2EE re-unlock) / awaiting key.
 * Port of iOS HomeGridView.
 */
package com.foresight.viewer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.foresight.viewer.contract.HomeDTO
import com.foresight.viewer.realtime.LiveCamera
import com.foresight.viewer.realtime.RoomManager
import com.foresight.viewer.session.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeGridScreen(session: Session, home: HomeDTO, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val room = remember(home.id) {
        RoomManager(context = context, homeId = home.id, api = session.api, session = session)
    }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var didInitialLoad by remember { mutableStateOf(false) }
    var showPairing by remember { mutableStateOf(false) }
    var fullScreenCamera by remember { mutableStateOf<LiveCamera?>(null) }

    suspend fun refreshCameras() {
        try {
            room.setRestCameras(session.api.listCameras(home.id))
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = e.message ?: "Could not load cameras."
        }
    }

    // Start: seed cameras, connect, then poll the registry every ~10 s.
    LaunchedEffect(home.id) {
        refreshCameras()
        didInitialLoad = true
        room.connect()
        while (true) {
            delay(10_000)
            refreshCameras()
        }
    }

    DisposableEffect(home.id) {
        onDispose { room.release() }
    }

    // When the E2EE identity finishes unlocking (biometric or password), a Home
    // that was held in Locked can connect and decrypt.
    val unlockPhase by session.unlockPhase.collectAsState()
    LaunchedEffect(unlockPhase) {
        if (unlockPhase == Session.UnlockPhase.Unlocked &&
            room.phase == RoomManager.ConnectionPhase.Locked
        ) {
            room.connect()
        }
    }

    val fullScreen = fullScreenCamera
    if (fullScreen != null) {
        BackHandler { fullScreenCamera = null }
        FullScreenCameraScreen(
            session = session,
            room = room,
            camera = fullScreen,
            // The grid outlives the full-screen view, so its scope can run the
            // exit work (stop talk/recording, restore quality) after dispose.
            exitScope = scope,
            onDismiss = { fullScreenCamera = null },
            onRemoved = {
                fullScreenCamera = null
                scope.launch { refreshCameras() }
            },
        )
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(home.name) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { showPairing = true }) {
                        Icon(Icons.Filled.AddAPhoto, contentDescription = "Add Camera")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            ConnectionBanner(session = session, room = room)
            errorMessage?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            if (room.cameras.isEmpty() && didInitialLoad) {
                EmptyCameras(onAdd = { showPairing = true })
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 160.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(room.cameras, key = { it.id }) { camera ->
                        CameraTile(
                            room = room,
                            camera = camera,
                            onClick = { fullScreenCamera = camera },
                        )
                    }
                }
            }
        }
    }

    if (showPairing) {
        AddCameraSheet(
            session = session,
            home = home,
            onDismiss = {
                showPairing = false
                scope.launch { refreshCameras() }
            },
        )
    }
}

@Composable
private fun ConnectionBanner(session: Session, room: RoomManager) {
    val scope = rememberCoroutineScope()
    when (val phase = room.phase) {
        RoomManager.ConnectionPhase.Connecting -> BannerColumn {
            Text(
                "Connecting to cameras…",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        is RoomManager.ConnectionPhase.Failed -> BannerColumn {
            BannerLabel(Icons.Filled.Warning, "Can't connect", MaterialTheme.colorScheme.error)
            Text(
                phase.message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = { scope.launch { room.connect() } }) { Text("Retry") }
        }

        RoomManager.ConnectionPhase.Locked -> BannerColumn {
            BannerLabel(Icons.Filled.Lock, "Unlock required", MaterialTheme.colorScheme.tertiary)
            Text(
                "This Home's cameras are end-to-end encrypted. Unlock to decrypt them on this device.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = { scope.launch { session.ensureIdentityUnlocked() } }) { Text("Unlock") }
        }

        RoomManager.ConnectionPhase.AwaitingKey -> BannerColumn {
            BannerLabel(Icons.Filled.Key, "Waiting for access", MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                "A Home member on the web dashboard needs to grant this device the camera key. " +
                    "This can take a moment.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = { scope.launch { room.connect() } }) { Text("Check again") }
        }

        else -> Unit
    }
}

@Composable
private fun BannerColumn(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) { content() }
}

@Composable
private fun BannerLabel(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    text: String,
    tint: androidx.compose.ui.graphics.Color,
) {
    androidx.compose.foundation.layout.Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.titleSmall, color = tint)
    }
}

@Composable
private fun EmptyCameras(onAdd: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.padding(32.dp),
        ) {
            Icon(
                Icons.Filled.VideocamOff,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(44.dp),
            )
            Text("No Cameras", style = MaterialTheme.typography.titleLarge)
            Text(
                "Add a camera by showing its pairing QR code to a Camera Client iPhone.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Button(onClick = onAdd) { Text("Add Camera") }
        }
    }
}
