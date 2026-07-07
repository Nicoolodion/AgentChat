package com.nicoolodion.agentchat

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.nicoolodion.agentchat.data.SettingsStore

class AgentChatApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        settingsStore = SettingsStore(this)
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_TASK,
            "Task notifications",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Notifies you when a task finishes."
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_TASK = "task_completion"
        lateinit var settingsStore: SettingsStore
            private set
        lateinit var instance: AgentChatApp
            private set
    }
}
