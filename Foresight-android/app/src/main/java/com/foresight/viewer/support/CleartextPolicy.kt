/*
 * Cleartext only on the local network (SEC-05).
 *
 * Passwords, session tokens and the LiveKit signaling token travel over these
 * connections. Plain http:// / ws:// is acceptable on a home LAN (the
 * documented setup), but never to a server across the internet, where anyone
 * on the path could read them. Android's network-security XML can't express IP
 * ranges, so the rule lives here and is applied to every API request and to
 * the LiveKit URL before connecting.
 */
package com.foresight.viewer.support

import java.net.URI

object CleartextPolicy {
    private val PRIVATE_SUFFIXES = listOf(".local", ".lan", ".home.arpa", ".internal")

    /** True for loopback, RFC 1918, link-local, CGNAT (Tailscale) and local names. */
    fun isPrivateHost(rawHost: String): Boolean {
        val host = rawHost.trim().trim('[', ']').lowercase()
        if (host == "localhost" || PRIVATE_SUFFIXES.any { host.endsWith(it) }) return true
        if (host == "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true
        val octets = host.split(".").map { it.toIntOrNull() ?: return false }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        val (a, b) = octets[0] to octets[1]
        return a == 10 || a == 127 ||
            (a == 192 && b == 168) ||
            (a == 172 && b in 16..31) ||
            (a == 169 && b == 254) ||
            (a == 100 && b in 64..127)
    }

    /** Why `url` must not be used, or null when it is fine. */
    fun violation(url: String): String? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "ws") return null
        val host = uri.host ?: return null
        if (isPrivateHost(host)) return null
        return "Refusing an unencrypted connection to $host, which is not on your local network. " +
            "Use https:// (and wss:// for LiveKit) for servers reached over the internet."
    }
}
