# JNA / lazysodium need their native interface classes kept if minification is
# ever enabled (release currently ships unminified).
-keep class com.sun.jna.** { *; }
-keep class com.goterl.lazysodium.** { *; }
-dontwarn java.awt.*
