package com.nicoolodion.agentchat

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.nicoolodion.agentchat.ui.AgentChatNavGraph
import com.nicoolodion.agentchat.ui.theme.AgentChatTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val openTaskId = intent?.getStringExtra("taskId")
        setContent {
            AgentChatTheme {
                AgentChatNavGraph(openTaskId = openTaskId)
            }
        }
    }
}
