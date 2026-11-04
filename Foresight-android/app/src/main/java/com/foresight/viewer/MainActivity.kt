/*
 * Single-activity Compose host. Extends FragmentActivity (not plain
 * ComponentActivity) because androidx.biometric's BiometricPrompt requires one
 * — the biometric identity unlock is triggered from Session via the
 * activityProvider registered here.
 */
package com.foresight.viewer

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.fragment.app.FragmentActivity
import com.foresight.viewer.ui.ForesightRoot
import com.foresight.viewer.ui.ForesightTheme

class MainActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as ForesightApplication
        app.session.activityProvider = { this }
        setContent {
            ForesightTheme {
                ForesightRoot(session = app.session, config = app.config)
            }
        }
    }

    override fun onDestroy() {
        val app = application as ForesightApplication
        // Drop the provider only if it still points at this instance.
        if (app.session.activityProvider() === this) {
            app.session.activityProvider = { null }
        }
        super.onDestroy()
    }
}
