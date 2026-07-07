package com.nicoolodion.agentchat.data.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.nicoolodion.agentchat.AgentChatApp
import com.nicoolodion.agentchat.MainActivity
import com.nicoolodion.agentchat.R
import org.unifiedpush.android.connector.UnifiedPush

/**
 * Receives ntfy/UnifiedPush delivery intents and posts a high-priority
 * ("Task finished") notification. Tapping it opens the task via MainActivity's
 * deep-link extra. Also handles distributor NEW_ENDPOINT / registration events.
 */
class UnifiedPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            "org.unifiedpush.android.connector.MESSAGE" -> {
                val bytes = intent.getByteArrayExtra("message") ?: return
                val payload = String(bytes).ifBlank { return }
                val taskId = extractField(payload, "taskId")
                val title = extractField(payload, "title") ?: "Task finished"
                val body = extractField(payload, "body") ?: ""
                postNotification(context, taskId, title, body)
            }
            "org.unifiedpush.android.connector.NEW_ENDPOINT" -> {
                val endpoint = intent.getStringExtra("endpoint") ?: return
                // The endpoint is the distributor's push URL. Our server only
                // needs the topic; the app registers the topic via /api/mobile/fcm-topic.
                // We keep UnifiedPush registered so intents keep arriving.
                Log.i("UnifiedPush", "New endpoint: $endpoint")
            }
            "org.unifiedpush.android.connector.UNREGISTERED",
            "org.unifiedpush.android.connector.REGISTRATION_FAILED" -> {
                Log.w("UnifiedPush", "Distributor unregistered: ${intent.action}")
            }
        }
    }

    private fun postNotification(context: Context, taskId: String?, title: String, body: String) {
        val openIntent = Intent(context, MainActivity::class.java).apply {
            action = "agentchat.intent.action.OPEN_TASK"
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (!taskId.isNullOrBlank()) putExtra("taskId", taskId)
        }
        val pi = android.app.PendingIntent.getActivity(
            context,
            taskId?.hashCode() ?: 0,
            openIntent,
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notif = NotificationCompat.Builder(context, AgentChatApp.CHANNEL_TASK)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(taskId?.hashCode() ?: System.currentTimeMillis().toInt(), notif)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS not granted — silent drop (user can grant in settings).
        }
    }

    private fun extractField(payload: String, field: String): String? {
        val regex = """"$field"\s*:\s*"((?:[^"\\]|\\.)*)"""".toRegex()
        return regex.find(payload)?.groupValues?.getOrNull(1)?.replace("\\\"", "\"")
    }
}
