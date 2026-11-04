/*
 * Configurable runtime settings. The API base URL is user-editable (Settings)
 * and persisted in SharedPreferences. The default targets the dev backend
 * through the Android emulator's host loopback (10.0.2.2); on a physical
 * device set it to the host's LAN IP (e.g. http://192.168.1.20:3199).
 */
package com.foresight.viewer.support

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class AppConfig(context: Context) {
    companion object {
        /** Android emulator alias for the host machine's localhost. */
        const val DEFAULT_BASE_URL = "http://10.0.2.2:3199"
        private const val PREF_BASE_URL = "foresight.apiBaseURL"
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences("foresight.config", Context.MODE_PRIVATE)

    private val _baseUrl = MutableStateFlow(readBaseUrl())
    val baseUrl: StateFlow<String> = _baseUrl

    private fun readBaseUrl(): String {
        val stored = prefs.getString(PREF_BASE_URL, null)
        return if (stored.isNullOrBlank()) DEFAULT_BASE_URL else stored
    }

    fun setBaseUrl(value: String) {
        val trimmed = value.trim().ifEmpty { DEFAULT_BASE_URL }
        prefs.edit().putString(PREF_BASE_URL, trimmed).apply()
        _baseUrl.value = trimmed
    }

    fun resetBaseUrl() = setBaseUrl(DEFAULT_BASE_URL)

    /** Normalized base URL for request building (no trailing slash). */
    fun resolveBaseUrl(): String = _baseUrl.value.trim().trimEnd('/')
}
