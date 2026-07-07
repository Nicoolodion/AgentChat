package com.nicoolodion.agentchat.data

import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import okhttp3.Interceptor
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Query
import java.util.concurrent.TimeUnit

data class PairRequest(val username: String, val password: String, val installId: String, val label: String? = null)
data class PairResponse(val token: String, val userId: String, val ntfyTopic: String, val ntfyAuth: String?, val ntfyBaseUrl: String?)

data class CreateTaskRequest(val prompt: String, val model: String? = null, val attachmentIds: List<String>? = null)
data class CreateTaskResponse(val taskId: String, val chatId: String?, val status: String? = null)

data class TaskRow(
    val id: String,
    val chatId: String?,
    val status: String,
    val source: String,
    val model: String?,
    val active: Boolean?,
    val createdAt: String,
    val completedAt: String?,
)
data class TasksResponse(val tasks: List<TaskRow>)

data class Artifact(
    val id: String,
    val fileName: String,
    val mimeType: String,
    val size: Int,
    val kind: String,
    val storagePath: String,
)
data class TaskResult(
    val id: String,
    val status: String,
    val title: String?,
    val model: String?,
    val result: String?,
    val reasoning: String?,
    val artifacts: List<Artifact>?,
    val completedAt: String?,
    val errorMessage: String?,
)
data class UploadResponse(val attachments: List<UploadAttachment>)
data class UploadAttachment(val id: String, val fileName: String, val mimeType: String, val size: Int, val kind: String)

interface AgentApi {
    @POST("api/mobile/pair")
    suspend fun pair(@Body body: PairRequest): PairResponse

    @GET("api/mobile/tasks")
    suspend fun listTasks(@Query("status") status: String? = null): TasksResponse

    @POST("api/mobile/tasks")
    suspend fun createTask(@Body body: CreateTaskRequest): CreateTaskResponse

    @Multipart
    @POST("api/mobile/uploads")
    suspend fun uploadFiles(@Part files: List<MultipartBody.Part>): UploadResponse

    @GET("api/mobile/tasks/{id}")
    suspend fun getTask(@Path("id") id: String): TaskResult

    @GET("api/mobile/tasks/{id}/result")
    suspend fun getResult(@Path("id") id: String): TaskResult

    @POST("api/mobile/tasks/{id}/cancel")
    suspend fun cancel(@Path("id") id: String): Map<String, String>
}

object ApiFactory {
    private val moshi: Moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()

    fun create(serverUrl: String, token: String?): AgentApi {
        val authInterceptor = Interceptor { chain ->
            val req = chain.request().newBuilder()
                .apply { if (!token.isNullOrEmpty()) addHeader("Authorization", "Bearer $token") }
                .build()
            chain.proceed(req)
        }
        val logging = HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC }
        val client = OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .addInterceptor(logging)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build()
        val retrofit = Retrofit.Builder()
            .baseUrl(if (serverUrl.endsWith("/")) serverUrl else "$serverUrl/")
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
        return retrofit.create(AgentApi::class.java)
    }
}
