package com.nicoolodion.agentchat.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.mikepenz.markdown.m3.Markdown
import com.nicoolodion.agentchat.data.TaskResult
import com.nicoolodion.agentchat.ui.ApiProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(taskId: String) {
    val scope = rememberCoroutineScope()
    var result by remember { mutableStateOf<TaskResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val baseUrl = com.nicoolodion.agentchat.AgentChatApp.settingsStore.serverUrl

    LaunchedEffect(taskId) {
        while (true) {
            try {
                val r = withContext(Dispatchers.IO) { ApiProvider.api().getResult(taskId) }
                result = r
            } catch (_: Exception) { }
            if (result?.status == "done" || result?.status == "error" || result?.status == "suppressed") break
            delay(3000)
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(result?.title ?: "Task") }) }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(16.dp).fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            val r = result
            if (r == null) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else {
                AssistChip(onClick = {}, label = { Text(r.status) })
                r.errorMessage?.let { Text("Error: $it", color = MaterialTheme.colorScheme.error) }
                if (!r.result.isNullOrBlank()) {
                    Markdown(content = r.result, modifier = Modifier.fillMaxWidth())
                } else if (r.status == "running" || r.status == "queued") {
                    Text("Running…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                r.artifacts?.takeIf { it.isNotEmpty() }?.let { arts ->
                    Text("Artifacts", style = MaterialTheme.typography.titleMedium)
                    arts.forEach { a ->
                        val url = "$baseUrl/api/mobile/tasks/$taskId/artifacts/${a.fileName}"
                        Text("• ${a.fileName} (${a.size} B)\n  $url", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
