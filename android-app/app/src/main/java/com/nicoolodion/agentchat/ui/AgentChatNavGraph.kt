package com.nicoolodion.agentchat.ui

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.nicoolodion.agentchat.ui.screen.NewTaskScreen
import com.nicoolodion.agentchat.ui.screen.PairingScreen
import com.nicoolodion.agentchat.ui.screen.SettingsScreen
import com.nicoolodion.agentchat.ui.screen.TaskDetailScreen
import com.nicoolodion.agentchat.ui.screen.TaskListScreen

object Routes {
    const val NEW_TASK = "new_task"
    const val LIST = "list"
    const val DETAIL = "detail/{taskId}"
    const val SETTINGS = "settings"
    const val PAIR = "pair"
}

@Composable
fun AgentChatNavGraph(openTaskId: String? = null) {
    val nav = rememberNavController()
    val startDest = if (openTaskId != null) "detail/$openTaskId" else Routes.LIST

    NavHost(navController = nav, startDestination = startDest) {
        composable(Routes.PAIR) {
            PairingScreen(onPaired = { nav.navigate(Routes.NEW_TASK) { popUpTo(Routes.LIST) } })
        }
        composable(Routes.LIST) {
            TaskListScreen(
                onOpenTask = { id -> nav.navigate("detail/$id") },
                onNewTask = { nav.navigate(Routes.NEW_TASK) },
                onSettings = { nav.navigate(Routes.SETTINGS) },
                onPair = { nav.navigate(Routes.PAIR) },
            )
        }
        composable(Routes.NEW_TASK) {
            NewTaskScreen(onSubmitted = { nav.popBackStack() })
        }
        composable(Routes.DETAIL) { backStack ->
            val id = backStack.arguments?.getString("taskId").orEmpty()
            TaskDetailScreen(taskId = id)
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(onLogout = { nav.navigate(Routes.PAIR) { popUpTo(0) } })
        }
    }
}
