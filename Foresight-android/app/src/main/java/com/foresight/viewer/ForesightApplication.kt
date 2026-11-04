/*
 * Application entry: builds the app-wide singletons (config, API client,
 * libsodium vault, session) — the Android analog of iOS Session.shared.
 */
package com.foresight.viewer

import android.app.Application
import com.foresight.viewer.crypto.IdentityVault
import com.foresight.viewer.crypto.LazySodiumOps
import com.foresight.viewer.network.ApiClient
import com.foresight.viewer.securestore.BiometricKeyCache
import com.foresight.viewer.securestore.SecureStore
import com.foresight.viewer.session.Session
import com.foresight.viewer.support.AppConfig
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid

class ForesightApplication : Application() {

    lateinit var config: AppConfig
        private set
    lateinit var session: Session
        private set

    override fun onCreate() {
        super.onCreate()
        instance = this

        config = AppConfig(this)
        val secureStore = SecureStore(this)
        val api = ApiClient(baseUrlProvider = { config.resolveBaseUrl() })
        val vault = IdentityVault(LazySodiumOps(LazySodiumAndroid(SodiumAndroid())))
        session = Session(
            api = api,
            vault = vault,
            secureStore = secureStore,
            biometricCache = BiometricKeyCache(this),
        )
    }

    companion object {
        lateinit var instance: ForesightApplication
            private set
    }
}
