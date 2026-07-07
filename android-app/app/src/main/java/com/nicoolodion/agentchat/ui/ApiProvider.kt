package com.nicoolodion.agentchat.ui

import com.nicoolodion.agentchat.AgentChatApp
import com.nicoolodion.agentchat.data.AgentApi
import com.nicoolodion.agentchat.data.ApiFactory

object ApiProvider {
    fun api(): AgentApi {
        val s = AgentChatApp.settingsStore
        return ApiFactory.create(s.serverUrl, s.token)
    }

    fun hasToken(): Boolean = !AgentChatApp.settingsStore.token.isNullOrEmpty()
}
