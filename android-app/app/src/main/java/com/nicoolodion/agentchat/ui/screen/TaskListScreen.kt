package com.nicoolodion.agentchat.ui.screen

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nicoolodion.agentchat.data.TaskRow
import com.nicoolodion.agentchat.ui.ApiProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskListScreen(onOpenTask: (String) -> Unit, onNewTask: () -> Unit, onSettings: () -> Unit, onPair: () -> Unit) {
    val scope = rememberCoroutineScope()
    var tasks by remember { mutableStateOf<List<TaskRow>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        if (!ApiProvider.hasToken()) { onPair(); return@LaunchedEffect }
        while (true) {
            try {
                tasks = withContext(Dispatchers.IO) { ApiProvider.api().listTasks() }.tasks
            } catch (_: Exception) { }
            delay(5000)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Tasks") },
                actions = {
                    IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings") }
                    IconButton(onClick = onNewTask) { Icon(Icons.Default.Add, contentDescription = "New task") }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onNewTask) { Icon(Icons.Default.Add, contentDescription = null) }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            if (tasks.isEmpty() && error == null) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("No tasks yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(tasks) { t ->
                        ListItem(
                            headlineContent = { Text(t.status) },
                            supportingContent = { Text("${t.source} · ${t.model ?: ""}") },
                            trailingContent = {
                                Surface(
                                    color = colorFor(t.status),
                                    shape = MaterialTheme.shapes.small,
                                ) { Text(t.status, modifier = Modifier.padding(horizontal = 6.dp), color = MaterialTheme.colorScheme.onPrimary) }
                            },
                            modifier = Modifier.clickable { onOpenTask(t.id) },
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun colorFor(status: String) = when (status) {
    "running", "queued" -> MaterialTheme.colorScheme.tertiary
    "done" -> MaterialTheme.colorScheme.primary
    "error" -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.surfaceVariant
}
