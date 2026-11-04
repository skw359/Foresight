/*
 * The pairing QR payload must be the PairingTicket as canonical JSON: exactly
 * the contract's five keys, alphabetically sorted, compact — decodable by the
 * camera client the same way as the iOS/web-generated QRs.
 */
package com.foresight.viewer.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class QrPayloadTest {

    private val ticket = PairingTicket(
        serverUrl = "http://192.168.1.20:3199",
        livekitUrl = "ws://192.168.1.20:7880",
        token = "one-time-token",
        homeId = "home_abc123",
        expiresAt = "2026-07-04T12:00:00.000Z",
    )

    @Test
    fun `payload keys are alphabetically sorted and compact`() {
        val payload = ticket.qrPayload()
        assertEquals(
            """{"expiresAt":"2026-07-04T12:00:00.000Z","homeId":"home_abc123",""" +
                """"livekitUrl":"ws://192.168.1.20:7880","serverUrl":"http://192.168.1.20:3199",""" +
                """"token":"one-time-token"}""",
            payload,
        )
        assertFalse(payload.contains("\n"))
        assertFalse(payload.contains(" \""))
    }

    @Test
    fun `payload round-trips through the contract decoder`() {
        val decoded = ForesightJson.decodeFromString(PairingTicket.serializer(), ticket.qrPayload())
        assertEquals(ticket, decoded)
    }

    @Test
    fun `payload contains exactly the five contract fields`() {
        val keys = Json.parseToJsonElement(ticket.qrPayload()).jsonObject.keys
        assertEquals(setOf("expiresAt", "homeId", "livekitUrl", "serverUrl", "token"), keys)
    }
}
