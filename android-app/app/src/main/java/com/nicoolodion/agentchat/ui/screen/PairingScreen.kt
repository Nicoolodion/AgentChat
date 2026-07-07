package com.nicoolodion.agentchat.ui.screen

import android.provider.Settings as AndroidSettings
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.nicoolodion.agentchat.AgentChatApp
import com.nicoolodion.agentchat.data.PairRequest
import com.nicoolodion.agentchat.ui.ApiProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(onPaired: () -> Unit) {
    val scope = rememberCoroutineScope()
    val store = AgentChatApp.settingsStore

    var serverUrl by remember { mutableStateOf(store.serverUrl) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    Scaffold(topBar = { TopAppBar(title = { Text("Pair device") }) }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = serverUrl,
                onValueChange = { serverUrl = it },
                label = { Text("Server URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("Username") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = {
                    if (loading) return@Button
                    loading = true; error = null
                    scope.launch {
                        try {
                            val installId = AndroidSettings.Secure.getString(
                                AgentChatApp.instance.contentResolver,
                                AndroidSettings.Secure.ANDROID_ID,
                            ) ?: "android-install"
                            val api = ApiFactory.create(serverUrl.trimEnd('/'), null)
                            val res = withContext(Dispatchers.IO) {
                                api.pair(PairRequest(username.trim(), password, installId))
                            }
                            store.serverUrl = serverUrl.trimEnd('/')
                            store.token = res.token
                            store.userId = res.userId
                            store.ntfyTopic = res.ntfyTopic
                            store.ntfyAuth = res.ntfyAuth
                            store.ntfyBaseUrl = res.ntfyBaseUrl
                            onPaired()
                        } catch (e: Exception) {
                            error = e.message ?: "Pairing failed"
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = serverUrl.isNotBlank() && username.isNotBlank() && password.isNotBlank() && !loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (loading) "Pairing…" else "Pair") }
        }
    }
}
