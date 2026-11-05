/*
 * Protocol JSON parity tests: encoding/decoding of the data-message union and
 * REST DTOs must match the canonical shared/ts contract — exact field names,
 * unknown-key tolerance, omitted nulls, and the "480p"/"1080p" enum spellings.
 */
package com.foresight.viewer.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolJsonTest {

    @Test
    fun `command message encodes v, type, target, action and args exactly`() {
        val message = CommandMessage(
            id = "cmd-1",
            target = "cam123",
            action = CommandAction.SET_QUALITY,
            args = CommandArgs(quality = QualityPreset.P1080),
        )
        val text = ForesightCodec.encode(message).decodeToString()
        val obj = Json.parseToJsonElement(text).jsonObject

        assertEquals("1", obj["v"].toString())
        assertEquals("\"command\"", obj["type"].toString())
        assertEquals("\"cmd-1\"", obj["id"].toString())
        assertEquals("\"cam123\"", obj["target"].toString())
        assertEquals("\"setQuality\"", obj["action"].toString())
        assertEquals("\"1080p\"", obj["args"]!!.jsonObject["quality"].toString())
        // Unset args fields are omitted, not null (matches Swift/TS encoders).
        assertFalse(obj["args"]!!.jsonObject.containsKey("on"))
    }

    @Test
    fun `command with no args omits the args key`() {
        val message = CommandMessage(id = "c", target = "t", action = CommandAction.SNAPSHOT_HINT)
        val text = ForesightCodec.encode(message).decodeToString()
        assertFalse(Json.parseToJsonElement(text).jsonObject.containsKey("args"))
    }

    @Test
    fun `state message decodes from the web wire format`() {
        val wire = """
            {"v":1,"type":"state","cameraId":"abc","torchOn":true,"lens":0.5,
             "zoom":2.5,"quality":"pure4k","recording":true,"talking":false}
        """.trimIndent()
        val decoded = ForesightCodec.decode(wire.encodeToByteArray())
        val state = decoded as StateMessage
        assertEquals("abc", state.cameraId)
        assertTrue(state.torchOn)
        assertEquals(0.5, state.lens, 1e-9)
        assertEquals(2.5, state.zoom, 1e-9)
        assertEquals(QualityPreset.PURE4K, state.quality)
        assertTrue(state.recording)
        assertFalse(state.talking)
    }

    @Test
    fun `telemetry decodes with nullable health fields`() {
        val wire = """
            {"v":1,"type":"telemetry","cameraId":"abc","battery":0.82,"charging":true,
             "wifi":{"level":3,"rssi":-52},"thermal":"serious","viewerCount":2}
        """.trimIndent()
        val telemetry = ForesightCodec.decode(wire.encodeToByteArray()) as TelemetryMessage
        assertEquals(0.82, telemetry.battery!!, 1e-9)
        assertEquals(3, telemetry.wifi!!.level)
        assertEquals(-52, telemetry.wifi!!.rssi)
        assertEquals(ThermalState.SERIOUS, telemetry.thermal)
        assertEquals(2, telemetry.viewerCount)

        val nulls = """{"v":1,"type":"telemetry","cameraId":"abc","battery":null,
            "charging":null,"wifi":null,"thermal":null,"viewerCount":0}"""
        val sparse = ForesightCodec.decode(nulls.encodeToByteArray()) as TelemetryMessage
        assertNull(sparse.battery)
        assertNull(sparse.wifi)
    }

    @Test
    fun `rekey decodes and epoch is bookkeeping only`() {
        val rekey = ForesightCodec.decode("""{"v":1,"type":"rekey","epoch":2}""".encodeToByteArray())
        assertEquals(2, (rekey as RekeyMessage).epoch)
        // The LiveKit key index is locked to 0 regardless of epoch (plan §3.2).
        assertEquals(0, ForesightE2EE.KEY_INDEX)
    }

    @Test
    fun `ack decodes and unknown message types return null`() {
        val ack = ForesightCodec.decode(
            """{"v":1,"type":"ack","commandId":"x","ok":false,"error":"nope"}""".encodeToByteArray(),
        ) as AckMessage
        assertFalse(ack.ok)
        assertEquals("nope", ack.error)

        assertNull(ForesightCodec.decode("""{"v":9,"type":"future-thing"}""".encodeToByteArray()))
        assertNull(ForesightCodec.decode("not json".encodeToByteArray()))
        assertNull(ForesightCodec.decode("""{"no":"type"}""".encodeToByteArray()))
    }

    @Test
    fun `messages with unknown extra keys still decode (forward compatibility)`() {
        val wire = """{"v":1,"type":"state","cameraId":"abc","torchOn":false,"lens":1,
            "zoom":1,"quality":"auto","recording":false,"talking":false,"futureField":123}"""
        assertTrue(ForesightCodec.decode(wire.encodeToByteArray()) is StateMessage)
    }

    @Test
    fun `HomeDTO decodes from pre-E2EE servers (missing keyEpoch) and current ones`() {
        val old = ForesightJson.decodeFromString(
            HomeDTO.serializer(),
            """{"id":"h1","name":"Home","role":"owner","createdAt":"2026-01-01T00:00:00Z"}""",
        )
        assertNull(old.keyEpoch)
        assertNull(old.recorderConsented)

        val current = ForesightJson.decodeFromString(
            HomeDTO.serializer(),
            """{"id":"h1","name":"Home","role":"member","createdAt":"x","keyEpoch":3,
               "recorderConsented":true,"someNewField":{"a":1}}""",
        )
        assertEquals(3, current.keyEpoch)
        assertEquals(true, current.recorderConsented)
        assertEquals(MemberRole.MEMBER, current.role)
    }

    @Test
    fun `AuthResponse decodes with and without a key vault`() {
        val withVault = ForesightJson.decodeFromString(
            AuthResponse.serializer(),
            """{"token":"t","user":{"id":"u1","identifier":"me@x.io","createdAt":"c"},
               "keyVault":{"publicKey":"cGs=","wrappedPrivateKey":"d3Br","nonce":"bm8=",
                           "kdf":{"algo":"argon2id","opslimit":3,"memlimit":67108864,"saltB64":"c2FsdA=="}}}""",
        )
        assertEquals(3, withVault.keyVault!!.kdf.opslimit)
        assertEquals(67108864, withVault.keyVault!!.kdf.memlimit)

        val withoutVault = ForesightJson.decodeFromString(
            AuthResponse.serializer(),
            """{"token":"t","user":{"id":"u1","identifier":"me","createdAt":"c"},"keyVault":null}""",
        )
        assertNull(withoutVault.keyVault)
    }

    @Test
    fun `RtTokenResponse carries keyEpoch and the sealed home key`() {
        val activated = ForesightJson.decodeFromString(
            RtTokenResponse.serializer(),
            """{"livekitUrl":"ws://x:7880","token":"jwt","room":"home:h1","identity":"user:u1:s1",
               "keyEpoch":2,"sealedHomeKey":{"ciphertext":"c2VhbGVk","epoch":2}}""",
        )
        assertEquals(2, activated.keyEpoch)
        assertEquals(2, activated.sealedHomeKey!!.epoch)

        val plaintextHome = ForesightJson.decodeFromString(
            RtTokenResponse.serializer(),
            """{"livekitUrl":"ws://x:7880","token":"jwt","room":"home:h1","identity":"user:u1:s1",
               "keyEpoch":0,"sealedHomeKey":null}""",
        )
        assertEquals(0, plaintextHome.keyEpoch)
        assertNull(plaintextHome.sealedHomeKey)
    }

    @Test
    fun `CameraDTO decodes capabilities and status`() {
        val camera = ForesightJson.decodeFromString(
            CameraDTO.serializer(),
            """{"id":"c1","homeId":"h1","name":"Front Door","online":true,
               "recordingEnabled":false,
               "status":{"battery":0.5,"charging":false,"wifi":{"level":4},"thermal":"nominal","lastSeen":"t"},
               "capabilities":{"lenses":[0.5,1,2],"maxDigitalZoom":6,"torch":true,
                                "maxResolution":{"width":3840,"height":2160},"supportsAudio":true},
               "createdAt":"t"}""",
        )
        assertEquals(listOf(0.5, 1.0, 2.0), camera.capabilities!!.lenses)
        assertEquals(3840, camera.capabilities!!.maxResolution.width)
        assertEquals(0.5, camera.status.battery!!, 1e-9)
    }

    @Test
    fun `auth request bodies match the contract exactly`() {
        assertEquals(
            """{"identifier":"me@x.io","password":"pw"}""",
            ForesightJson.encodeToString(LoginRequest.serializer(), LoginRequest("me@x.io", "pw")),
        )
        // firstName omitted when null (single-identifier + no-complexity contract).
        assertEquals(
            """{"identifier":"someone","password":"p"}""",
            ForesightJson.encodeToString(RegisterRequest.serializer(), RegisterRequest("someone", "p")),
        )
    }

    @Test
    fun `rt token request omits deviceSecret for viewers`() {
        assertEquals(
            """{"homeId":"h1","role":"viewer"}""",
            ForesightJson.encodeToString(
                RtTokenRequest.serializer(),
                RtTokenRequest("h1", ParticipantRole.VIEWER),
            ),
        )
    }

    @Test
    fun `rename and create-home bodies match`() {
        assertEquals(
            """{"name":"Backyard"}""",
            ForesightJson.encodeToString(RenameCameraRequest.serializer(), RenameCameraRequest("Backyard")),
        )
        assertEquals(
            """{"name":"Lake House"}""",
            ForesightJson.encodeToString(CreateHomeRequest.serializer(), CreateHomeRequest("Lake House")),
        )
    }

    @Test
    fun `identity helpers mirror realtime ts`() {
        assertEquals("home:h1", Foresight.homeRoom("h1"))
        assertEquals("camera:c1", Foresight.cameraIdentity("c1"))
        assertEquals("user:u1:s1", Foresight.viewerIdentity("u1", "s1"))

        val camera = Foresight.parseIdentity("camera:c1")!!
        assertEquals(ParticipantRole.CAMERA, camera.role)
        assertEquals("c1", camera.id)

        // Canonical TS split(":") semantics: the id is the second segment only.
        val viewer = Foresight.parseIdentity("user:u1:sess")!!
        assertEquals(ParticipantRole.VIEWER, viewer.role)
        assertEquals("u1", viewer.id)

        assertNull(Foresight.parseIdentity("recorder:x"))
        assertNull(Foresight.parseIdentity("garbage"))
        assertNull(Foresight.parseIdentity("camera:"))
    }
}
