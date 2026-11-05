package com.foresight.viewer.contract

import com.foresight.viewer.support.CleartextPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PROTO-01 / SEC-05 rules shared with every other client: data messages are
 * version-checked, senders authorized, and cleartext stays on the LAN.
 */
class ProtocolRulesTest {
    private fun bytes(json: String) = json.encodeToByteArray()

    private val telemetryA = TelemetryMessage(
        cameraId = "A", battery = 0.5, charging = true, wifi = null, thermal = null, viewerCount = 1,
    )

    @Test
    fun rejectsOtherProtocolVersions() {
        assertNotNull(ForesightCodec.decode(bytes("""{"v":1,"type":"rekey","epoch":2}""")))
        assertNull(ForesightCodec.decode(bytes("""{"v":2,"type":"rekey","epoch":2}""")))
        assertNull(ForesightCodec.decode(bytes("""{"v":1,"type":"selfDestruct"}""")))
    }

    @Test
    fun acceptsCameraStateOnlyFromThatCamera() {
        assertTrue(Foresight.isAuthorizedSender(telemetryA, "camera:A"))
        assertFalse(Foresight.isAuthorizedSender(telemetryA, "camera:B"))
        assertFalse(Foresight.isAuthorizedSender(telemetryA, "user:u1:s1"))
        assertFalse(Foresight.isAuthorizedSender(telemetryA, null))
    }

    @Test
    fun commandsOnlyFromViewersAndRekeyFromServerOrViewer() {
        val cmd = CommandMessage(target = "A", action = CommandAction.TORCH)
        assertTrue(Foresight.isAuthorizedSender(cmd, "user:u1:s1"))
        assertFalse(Foresight.isAuthorizedSender(cmd, null))
        assertFalse(Foresight.isAuthorizedSender(cmd, "camera:B"))
        val rekey = RekeyMessage(epoch = 3)
        assertTrue(Foresight.isAuthorizedSender(rekey, null))
        assertTrue(Foresight.isAuthorizedSender(rekey, "user:u1:s1"))
        assertFalse(Foresight.isAuthorizedSender(rekey, "camera:A"))
    }

    @Test
    fun cleartextOnlyToPrivateHosts() {
        assertNull(CleartextPolicy.violation("http://192.168.1.20:3199"))
        assertNull(CleartextPolicy.violation("ws://10.0.2.2:7880"))
        assertNull(CleartextPolicy.violation("http://nas.local:3199"))
        assertNull(CleartextPolicy.violation("http://100.101.102.103:3199")) // Tailscale
        assertNull(CleartextPolicy.violation("https://cams.example.com"))
        assertNotNull(CleartextPolicy.violation("http://cams.example.com"))
        assertNotNull(CleartextPolicy.violation("ws://203.0.113.9:7880"))
        assertEquals(false, CleartextPolicy.isPrivateHost("8.8.8.8"))
    }
}
