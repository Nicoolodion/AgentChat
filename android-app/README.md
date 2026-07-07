# Android app — Chatinterface Agent

Native Kotlin (Jetpack Compose, Material 3) front-end for the Mobile Task
Launcher. No Google dependencies: push delivery is via **UnifiedPush** (ntfy in
self-hosted mode). minSdk 26.

## Build locally

```sh
cd chatinterface-app/android-app
# First time only: generate the Gradle wrapper jar (requires a local gradle):
gradle wrapper
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

Sideload the APK. Pair with username + password against your server URL.

## Release builds (CI)

Tagging `mobile-v*` triggers `.github/workflows/android-release.yml`, which
builds a signed release APK using GitHub secrets:

- `ANDROID_KEYSTORE` — base64-encoded keystore (generate locally with `keytool`)
- `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_STORE_PASSWORD`

The APK is published to a GitHub Release for sideloading.

## Push (UnifiedPush)

Install any UnifiedPush distributor on your phone — for a fully self-hosted
setup use the [ntfy Android app](https://ntfy.sh) pointed at your self-hosted
`ntfy.nicoolodion.com` (Settings → Connection URL in the ntfy app).

The app registers for push via the UnifiedPush connector; ntfy delivery intents
are handled by `UnifiedPushReceiver` which posts a task-completion
notification. Tapping it deep-links to the task detail screen.
