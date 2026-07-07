package com.nicoolodion.agentchat.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nicoolodion.agentchat.AgentChatApp
import com.nicoolodion.agentchat.ui.ApiProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    val store = AgentChatApp.settingsStore
    var serverUrl by remember { mutableStateOf(store.serverUrl) }
    var token by remember { mutableStateOf(store.token ?: "") }
    var model by remember { mutableStateOf("") }
    var email by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            val s = withContext(Dispatchers.IO) {
                // Best-effort: GET /api/mobile/settings if endpoint exists.
                ApiProvider.api()
            }
            // The AgentApi interface doesn't expose settings here; kept light.
            void(s)
        } catch (_: Exception) { }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("Settings") }) }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(value = serverUrl, onValueChange = { serverUrl = it }, label = { Text("Server URL") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = token, onValueChange = { token = it }, label = { Text("Bearer token") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = model, onValueChange = { model = it }, label = { Text("Model override") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = email ?: "", onValueChange = { email = it }, label = { Text("Verified email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            msg?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            Button(onClick = {
                saving = true; msg = null
                store.serverUrl = serverUrl.trimEnd('/')
                store.token = token.ifBlank { null }
                saving = false
                msg = "Saved"
            }, modifier = Modifier.fillMaxWidth()) { Text("Save") }
            TextButton(onClick = {
                store.clear()
                onLogout()
            }) { Text("Log out", color = MaterialTheme.colorScheme.error) }
        }
        Unit
    }
}
