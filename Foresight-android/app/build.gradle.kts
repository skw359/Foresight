plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.foresight.viewer"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.foresight.viewer"
        // 29+ keeps MediaStore saves permission-free (scoped storage ownership model).
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    testOptions {
        unitTests {
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.biometric)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.livekit.android)
    // livekit exposes proto types (Encryption.Type) in its public API surface;
    // the javalite runtime must be on the compile classpath to name them.
    implementation(libs.protobuf.javalite)
    implementation(libs.zxing.core)

    // libsodium: the Android build ships .so for device ABIs; JVM unit tests use
    // lazysodium-java (below), which bundles desktop natives. The crypto layer is
    // written against the shared LazySodium base class so both are interchangeable.
    // lazysodium-android transitively wants the plain jna JAR; the app must use
    // the @aar variant instead (Android natives) — exclude to avoid duplicates.
    implementation(libs.lazysodium.android) {
        exclude(group = "net.java.dev.jna", module = "jna")
    }
    implementation("${libs.jna.android.get()}@aar")

    testImplementation(libs.junit)
    testImplementation(libs.lazysodium.java) // pulls desktop JNA transitively
}
