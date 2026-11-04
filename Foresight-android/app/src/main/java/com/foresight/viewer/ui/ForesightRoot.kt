/*
 * Root routing: auth flow vs. the authenticated Homes experience, plus the
 * app-wide cold-launch E2EE password re-unlock dialog (raised from anywhere the
 * identity key is needed but absent — plan §7.4). Port of iOS RootView.
 */
package com.foresight.viewer.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.foresight.viewer.session.Session
import com.foresight.viewer.support.AppConfig

@Composable
fun ForesightRoot(session: Session, config: AppConfig) {
    val phase by session.phase.collectAsState()
    val presentUnlock by session.isPresentingPasswordUnlock.collectAsState()

    Surface(modifier = Modifier.fillMaxSize()) {
        when (phase) {
            is Session.Phase.Authenticated -> HomesNav(session = session, config = config)
            Session.Phase.Unauthenticated -> AuthScreen(session = session, config = config)
        }
    }

    if (presentUnlock) {
        UnlockDialog(session = session)
    }
}
