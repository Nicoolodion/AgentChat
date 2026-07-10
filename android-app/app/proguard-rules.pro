# UnifiedPush + Retrofit keep rules
-keep class org.unifiedpush.android.** { *; }
-keepclassmembers,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-keep class com.squareup.moshi.** { *; }

# Tink (via androidx.security.crypto) references errorprone annotations
# that aren't on the runtime classpath. Suppress the missing-class errors.
-dontwarn com.google.errorprone.annotations.**
