plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.dsharnessmobile.shell"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.dsharnessmobile.shell"
    minSdk = 26
    // targetSdk 34: Android 15+ forbids exec of app-data ELF for targetSdk 35+
    // (the embedded engine, bash, and every child command would need linker64
    // wrappers); 34 keeps native exec working on Android 15/16 devices.
    targetSdk = 34
    // 0.14.0-preview：versionCode 38（覆盖安装 0.13.8(37)）。本版主题（迭代计划
    // docs/NEXT-ITERATION-PLAN-2026-09-12.md 的切片 1 = B0+B1+B2）：
    // ① B0 发布阻断项清零：android_ui_dump schema 族与返回面脱钩（#204）、控制协议 V2 行句柄
    //    口径（#206.1，载荷行下标 → 原始行号）、file-incoming 三条 exact 路由无鉴权（#205）；
    // ② B1 数据与自愈：#210 半死状态机四缺口、#211 壳侧 IO 三处、状态陈旧 P0（真源 + 同步路径）、
    //    临时工作区 R1-R3；
    // ③ B2 门禁与发布链：新增门禁接进唯一接线面（本地构建链 / 两仓 CI / 发布组装链三处），
    //    快照指纹对账、工具返回值 schema 自检、控制 op 六处登记链、SKIP 计数。
    versionCode = 38
    // Snapshot builds append a suffix (e.g. -SN-1-RC13) via -PversionNameSuffix; release builds pass none.
    val snapshotSuffix = providers.gradleProperty("versionNameSuffix").getOrElse("")
    // 版本号单一来源：UI（GuidePageRenderer）、桥（androidBridge.version）、诊断日志、引擎环境变量
    // （DSH_APP_VERSION，见 EngineManager.engineEnv）全部读这里，禁止任何地方再硬编码版本字面量。
    versionName = "0.14.0-preview" + snapshotSuffix
    buildConfigField("String", "TERMUX_VERSION", "\"0.118.3\"")
    // 4Debian 变体（M1 预览）：app 名走 resValue（debian flavor 覆盖为 DSH Debian），原 strings.xml 的
    // app_name 移到这里（flavor resValue 不能与 res 目录同名资源共存）。
    resValue("string", "app_name", "DeepCode")
    // 0.14.0-preview：虚拟屏 P0 建屏矩阵走仪器测试入口（app UID 下运行 = P0-6 要测的调用者身份），
    // 不新增任何产品面（Activity/Bridge/Manifest 均不动）。见 .deploy-tmp/iter-0140/vdisplay-p0.md §8.8。
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  // 4Debian 双运行时变体（docs/design-4debian.md D-0/D-3；坑 98/99/100/101/102 的实证链）：
  //   termux = Termux 快照（现状，全设备保底，资产 snapshot.tar.xz）
  //   debian = Debian rootfs + D-6 ld.so 直启链 + LD_PRELOAD exec 拦截器（资产 debian-rootfs.tar.xz）
  // 布局复用：Debian rootfs 整树改挂 files/usr（usr/usr/bin/node…），解压/事务/指纹机制零改动；
  // 启动链按 BuildConfig.DEBIAN_RUNTIME 分支（EngineManager）。flavor 不能叫 "main"（与内置
  // sourceSet 同名 → generateSources 任务键冲突，AGP 实锤）。
  flavorDimensions += "runtime"
  productFlavors {
    create("termux") {
      dimension = "runtime"
      buildConfigField("boolean", "DEBIAN_RUNTIME", "false")
    }
    create("debian") {
      dimension = "runtime"
      // 不能用 applicationIdSuffix "4d"（段首数字非法）——直接覆写完整 id
      applicationId = "com.dsharnessmobile.shell4d"
      // D-6 前置（坑 98/103）：untrusted_app（targetSdk 29+）域对 app-data ELF 的 exec 恒 EACCES
      // （Android 10 起 SELinux 化，模拟器与 vivo 16 双实锤；linker64 fallback 只救 bionic ELF，
      // 对 glibc ld.so 报 "Could not find a PHDR"）。targetSdk<=28 落 untrusted_app_27 域 =
      // Termux 存活至今的同一豁免 → D-6 直启链（exec glibc ld.so）合法。预览版代价：
      // 继承旧存储语义/无 scoped storage，正式版需换 nativeLibraryDir 静态蹦床或 memfd 路线。
      targetSdk = 28
      versionNameSuffix = "-d1"
      resValue("string", "app_name", "DSH Debian (Preview)")
      buildConfigField("boolean", "DEBIAN_RUNTIME", "true")
    }
  }

  buildFeatures {
    buildConfig = true
    // 0.14.0-preview：ShizukuUserService.aidl 生成 Stub（虚拟屏线 S5 的 bindUserService 需要）。
    // 惰性：当前无 Kotlin 引用该 aidl 时也不会产生额外产物。
    aidl = true
  }

  androidResources {
    // snapshot.tar.xz is already xz-compressed; double-compressing it breaks openFd.
    noCompress += "xz"
  }

  signingConfigs {
    // Fixed debug signing from the repo keystore: CI and local builds must produce
    // byte-compatible signatures, otherwise users cannot install over previous
    // releases (INSTALL_FAILED_UPDATE_INCOMPATIBLE). AGP's default debug keystore
    // lookup (~/.android/debug.keystore) is unreliable on CI runners, so pin it.
    create("repoDebug") {
      storeFile = rootProject.file("keystore/debug.keystore")
      storePassword = "android"
      keyAlias = "androiddebugkey"
      keyPassword = "android"
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
    debug {
      signingConfig = signingConfigs.getByName("repoDebug")
    }
  }

  lint {
    // Offline environments lack the lint-gradle dependency cache (CN networks); lint is not on the release-critical path.
    checkReleaseBuilds = false
    abortOnError = false
  }

  testOptions {
    // Snapshot extraction/tests touch android.util.Log; default stubs keep the JVM
    // unit tests runnable without Robolectric.
    unitTests.isReturnDefaultValues = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

// The runtime snapshot comes from GitHub Releases (large files are not committed); the build fails with fetch guidance when it is missing.
// 运行时资产守卫（4Debian 起 flavor 化：任务名 merge<Flavor><BuildType>Assets）。
// main 校验 Termux 快照；debian 校验 Debian rootfs（由 scripts/build-rootfs-g2.mjs --apk-asset 产出，
// 大文件不入库，.gitignore 已排除）。
tasks.whenTaskAdded {
  if (name.endsWith("Assets") && name.startsWith("merge")) {
    val flavor = name.removePrefix("merge").removeSuffix("Assets")
      .removeSuffix("Debug").removeSuffix("Release")
    val (asset, hint) = if (flavor == "Debian") {
      "src/debian/assets/debian-rootfs.tar.xz" to
        "node scripts/build-rootfs-g2.mjs arm64 --apk-asset 生成（4Debian 预览载荷，见 docs/design-4debian.md）"
    } else {
      "src/main/assets/snapshot.tar.xz" to
        "从 GitHub Releases 下载 snapshot-x86_64.tar.xz 后放到 app/src/main/assets/snapshot.tar.xz（见 README.md）"
    }
    doFirst {
      if (!file(asset).exists()) {
        throw GradleException("缺少运行时资产 $asset —— $hint")
      }
    }
  }
}

dependencies {
  // Shizuku 特权通道（0.14.0-preview 虚拟屏线 P0-0）：Maven Central 13.1.5（2023-09-21；上游
  // App 仍更新但库停更，只按 13.1.5 API 面写代码）。许可 MIT（aar POM <licenses> 实测），
  // minSdk 26 >= aar 的 24/23，无需 desugaring；settings.gradle.kts 已有 mavenCentral()。
  implementation("dev.rikka.shizuku:api:13.1.5")
  implementation("dev.rikka.shizuku:provider:13.1.5")
  implementation("androidx.activity:activity-ktx:1.10.1")
  // androidx.core: FileProvider (external-reader open, issue #52); ViewCompat/
  // WindowInsetsCompat were previously satisfied transitively via activity-ktx.
  implementation("androidx.core:core-ktx:1.15.0")
  // 悬浮球 v2 动效（PRD-overlay-v2 §3.5）：Material 3 Expressive spring 物理（Android 16 原生适配）
  implementation("androidx.dynamicanimation:dynamicanimation:1.1.0")
  implementation("org.apache.commons:commons-compress:1.28.0")
  implementation("org.tukaani:xz:1.10")
  testImplementation("junit:junit:4.13.2")
  // 仪器测试（虚拟屏建屏矩阵）：只用于 P0 探针，不进产品面。
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  // 本地单测用真实 org.json（android.jar 桩在 JVM 里抛 Stub!）——快照 profiles 合并（#167）测试需要
  testImplementation("org.json:json:20240303")
}
