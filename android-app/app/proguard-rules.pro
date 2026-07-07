# UnifiedPush + Retrofit keep rules
-keep class org.unifiedpush.android.** { *; }
-keepclassmembers,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-keep class com.squareup.moshi.** { *; }
