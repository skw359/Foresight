/*
 * Canonical QR payload for camera pairing: the PairingTicket encoded as JSON
 * with alphabetically sorted keys — the same shape the iOS viewer emits
 * (JSONEncoder .sortedKeys) and the camera client decodes. Field order and
 * names are part of the de-facto canonical form; values are plain strings so
 * no escaping differences arise between platforms.
 */
package com.foresight.viewer.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

fun PairingTicket.qrPayload(): String {
    // Insertion order == output order for JsonObject; insert sorted.
    val fields = sortedMapOf(
        "expiresAt" to expiresAt,
        "homeId" to homeId,
        "livekitUrl" to livekitUrl,
        "serverUrl" to serverUrl,
        "token" to token,
    )
    val obj = JsonObject(fields.mapValues { JsonPrimitive(it.value) })
    return Json.encodeToString(JsonObject.serializer(), obj)
}
