/*
 * Typed REST client for the Foresight backend. Every method maps 1:1 to an
 * endpoint in shared/PROTOCOL.md; the JWT (when present) is attached as
 * `Authorization: Bearer <token>` automatically. Port of the iOS APIClient
 * (URLSession → OkHttp, same 20 s request timeout, same error decoding).
 */
package com.foresight.viewer.network

import com.foresight.viewer.contract.AddMemberRequest
import com.foresight.viewer.contract.ApiErrorBody
import com.foresight.viewer.contract.AuthResponse
import com.foresight.viewer.contract.CameraDTO
import com.foresight.viewer.contract.CreateHomeRequest
import com.foresight.viewer.contract.EncryptedKeyVault
import com.foresight.viewer.contract.ForesightJson
import com.foresight.viewer.contract.HomeDTO
import com.foresight.viewer.contract.HomeKeyResponse
import com.foresight.viewer.contract.LoginRequest
import com.foresight.viewer.contract.MeKeysResponse
import com.foresight.viewer.contract.MemberRole
import com.foresight.viewer.contract.PairingTicket
import com.foresight.viewer.contract.ParticipantRole
import com.foresight.viewer.contract.RegisterRequest
import com.foresight.viewer.contract.RenameCameraRequest
import com.foresight.viewer.contract.RtTokenRequest
import com.foresight.viewer.contract.RtTokenResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Error surfaced by the backend `{ error, message }`, plus transport errors. */
class ApiException(val error: String, override val message: String, val status: Int? = null) :
    Exception(message) {
    companion object {
        fun transport(message: String) = ApiException("transport", message)
    }
}

class ApiClient(
    private val baseUrlProvider: () -> String,
    initialToken: String? = null,
) {
    @Volatile
    private var token: String? = initialToken

    private val json: Json = ForesightJson

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(25, TimeUnit.SECONDS)
        .build()

    fun setToken(newToken: String?) {
        token = newToken
    }

    // MARK: - Auth

    suspend fun register(identifier: String, password: String): AuthResponse =
        post("/auth/register", RegisterRequest(identifier, password), RegisterRequest.serializer(),
            AuthResponse.serializer(), authed = false)

    suspend fun login(identifier: String, password: String): AuthResponse =
        post("/auth/login", LoginRequest(identifier, password), LoginRequest.serializer(),
            AuthResponse.serializer(), authed = false)

    // MARK: - Homes

    suspend fun listHomes(): List<HomeDTO> =
        get("/homes", ListSerializer(HomeDTO.serializer()))

    suspend fun createHome(name: String): HomeDTO =
        post("/homes", CreateHomeRequest(name), CreateHomeRequest.serializer(), HomeDTO.serializer())

    suspend fun addMember(homeId: String, identifier: String, role: MemberRole? = null): HomeDTO =
        post("/homes/$homeId/members", AddMemberRequest(identifier, role),
            AddMemberRequest.serializer(), HomeDTO.serializer())

    // MARK: - Cameras

    suspend fun listCameras(homeId: String): List<CameraDTO> =
        get("/homes/$homeId/cameras", ListSerializer(CameraDTO.serializer()))

    suspend fun pairCamera(homeId: String): PairingTicket =
        post("/homes/$homeId/cameras/pair", null, null, PairingTicket.serializer())

    suspend fun renameCamera(cameraId: String, name: String): CameraDTO =
        request("PATCH", "/cameras/$cameraId", RenameCameraRequest(name),
            RenameCameraRequest.serializer(), CameraDTO.serializer(), authed = true)

    suspend fun removeCamera(cameraId: String) {
        requestRaw("DELETE", "/cameras/$cameraId", null, null as KSerializer<Unit>?, authed = true)
    }

    // MARK: - Realtime token

    suspend fun rtToken(homeId: String, role: ParticipantRole = ParticipantRole.VIEWER): RtTokenResponse =
        post("/rt/token", RtTokenRequest(homeId, role), RtTokenRequest.serializer(),
            RtTokenResponse.serializer())

    // MARK: - E2EE key vault / Home keys (plan §5, §7.4)

    /** The caller's encrypted key vault (null ⇒ run first-login key generation). */
    suspend fun getMyKeys(): MeKeysResponse =
        get("/me/keys", MeKeysResponse.serializer())

    /** Upload a freshly-generated key vault (first-login migration); 204 response. */
    suspend fun setMyKeys(vault: EncryptedKeyVault) {
        requestRaw("POST", "/me/keys", vault, EncryptedKeyVault.serializer(), authed = true)
    }

    /**
     * The caller's own sealed HMK copy at the Home's current epoch. Used to
     * re-fetch after a `rekey` data message (rotation).
     */
    suspend fun homeKey(homeId: String): HomeKeyResponse =
        get("/homes/$homeId/key", HomeKeyResponse.serializer())

    // MARK: - Core

    private suspend fun <R> get(path: String, responseSerializer: KSerializer<R>): R =
        request("GET", path, null, null, responseSerializer, authed = true)

    private suspend fun <B, R> post(
        path: String,
        body: B?,
        bodySerializer: KSerializer<B>?,
        responseSerializer: KSerializer<R>,
        authed: Boolean = true,
    ): R = request("POST", path, body, bodySerializer, responseSerializer, authed)

    private suspend fun <B, R> request(
        method: String,
        path: String,
        body: B?,
        bodySerializer: KSerializer<B>?,
        responseSerializer: KSerializer<R>,
        authed: Boolean,
    ): R {
        val data = requestRaw(method, path, body, bodySerializer, authed)
        return try {
            json.decodeFromString(responseSerializer, data)
        } catch (e: Exception) {
            throw ApiException.transport("Could not parse server response: ${e.message}")
        }
    }

    private suspend fun <B> requestRaw(
        method: String,
        path: String,
        body: B?,
        bodySerializer: KSerializer<B>?,
        authed: Boolean,
    ): String = withContext(Dispatchers.IO) {
        val builder = Request.Builder()
            .url(baseUrlProvider().trimEnd('/') + path)
            .header("Accept", "application/json")

        if (authed) {
            token?.let { builder.header("Authorization", "Bearer $it") }
        }

        val requestBody = if (body != null && bodySerializer != null) {
            json.encodeToString(bodySerializer, body)
                .toRequestBody("application/json".toMediaType())
        } else if (method == "POST" || method == "PATCH") {
            // Endpoints like /cameras/pair take no body; OkHttp still requires one.
            ByteArray(0).toRequestBody(null)
        } else {
            null
        }
        builder.method(method, requestBody)

        val response = try {
            client.newCall(builder.build()).execute()
        } catch (e: IOException) {
            throw ApiException.transport(e.message ?: "Network request failed.")
        }

        response.use {
            val text = it.body?.string() ?: ""
            if (!it.isSuccessful) {
                val apiError = try {
                    json.decodeFromString(ApiErrorBody.serializer(), text)
                } catch (_: Exception) {
                    null
                }
                if (apiError != null) {
                    throw ApiException(apiError.error, apiError.message.ifEmpty { apiError.error }, it.code)
                }
                throw ApiException("http_${it.code}", "Request failed (HTTP ${it.code}).", it.code)
            }
            text
        }
    }
}
