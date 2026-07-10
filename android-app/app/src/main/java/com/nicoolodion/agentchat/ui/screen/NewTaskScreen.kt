package com.nicoolodion.agentchat.ui.screen

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nicoolodion.agentchat.data.CreateTaskRequest
import com.nicoolodion.agentchat.ui.ApiProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewTaskScreen(onSubmitted: () -> Unit) {
    val scope = rememberCoroutineScope()
    var prompt by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var selectedUris by remember { mutableStateOf<List<Uri>>(emptyList()) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        selectedUris = uris
    }

    Scaffold(topBar = { TopAppBar(title = { Text("New task") }) }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                label = { Text("Describe your task…") },
                modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { picker.launch("*/*") }) {
                    Icon(Icons.Default.AttachFile, contentDescription = null); Spacer(Modifier.width(4.dp)); Text("Attach")
                }
                if (selectedUris.isNotEmpty()) Text("${selectedUris.size} file(s)")
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                onClick = {
                    if (loading || prompt.isBlank()) return@Button
                    loading = true; error = null
                    scope.launch {
                        try {
                            val api = ApiProvider.api()
                            var attachmentIds: List<String>? = null
                            if (selectedUris.isNotEmpty()) {
                                val parts = mutableListOf<MultipartBody.Part>()
                                for (uri in selectedUris) {
                                    val ctx = com.nicoolodion.agentchat.AgentChatApp.instance
                                    val cr = ctx.contentResolver
                                    val name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
                                    val mime = cr.getType(uri) ?: "application/octet-stream"
                                    val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: continue
                                    val mediaType = mime.toMediaType()
                                    val body = bytes.toRequestBody(mediaType)
                                    parts += MultipartBody.Part.createFormData("files", name, body)
                                }
                                val up = withContext(Dispatchers.IO) { api.uploadFiles(parts) }
                                attachmentIds = up.attachments.map { it.id }
                            }
                            withContext(Dispatchers.IO) {
                                api.createTask(CreateTaskRequest(prompt.trim(), attachmentIds = attachmentIds))
                            }
                            prompt = ""
                            selectedUris = emptyList()
                            onSubmitted()
                        } catch (e: Exception) {
                            error = e.message ?: "Failed to start task"
                        } finally {
                            loading = false
                        }
                    }
                },
                enabled = prompt.isNotBlank() && !loading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (loading) "Sending…" else "Send") }
            if (loading) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
    }
}
