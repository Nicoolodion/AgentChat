package com.nicoolodion.agentchat.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Encrypted settings store holding the server URL, bearer token, ntfy topic
 * + auth, and default model. Uses EncryptedSharedPreferences (API 23+).
 */
class SettingsStore(context: Context) {
    private val prefs = run {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context,
            "agentchat_secrets",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "https://chat.nicoolodion.com") ?: DEFAULT_URL
        set(v) = prefs.edit().putString(KEY_SERVER_URL, trimUrl(v)).apply()

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_TOKEN, v).apply()

    var ntfyTopic: String?
        get() = prefs.getString(KEY_NTFY_TOPIC, null)
        set(v) = prefs.edit().putString(KEY_NTFY_TOPIC, v).apply()

    var ntfyAuth: String?
        get() = prefs.getString(KEY_NTFY_AUTH, null)
        set(v) = prefs.edit().putString(KEY_NTFY_AUTH, v).apply()

    var ntfyBaseUrl: String?
        get() = prefs.getString(KEY_NTFY_BASE, null)
        set(v) = prefs.edit().putString(KEY_NTFY_BASE, v).apply()

    var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(v) = prefs.edit().putString(KEY_USER_ID, v).apply()

    fun clear() {
        prefs.edit().clear().apply()
    }

    private fun trimUrl(url: String): String = url.trimEnd('/')

    companion object {
        private const val DEFAULT_URL = "https://chat.nicoolodion.com"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_TOKEN = "bearer_token"
        private const val KEY_NTFY_TOPIC = "ntfy_topic"
        private const val KEY_NTFY_AUTH = "ntfy_auth"
        private const val KEY_NTFY_BASE = "ntfy_base"
        private const val KEY_USER_ID = "user_id"
    }
}
