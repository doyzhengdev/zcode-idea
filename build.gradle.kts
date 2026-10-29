plugins {
    id("idea")
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.serialization") version "2.1.0"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

// 各工具的项目级缓存与生成产物不参与 IDE 索引/搜索（.gradle、build 由 Gradle 导入自动排除；
// vendor/ZCode 保留源码索引供跳转，但其 node_modules 排除以控制索引体量）。
// 写在这里每次 Sync 自动生效，比在 IDEA 里手动 Mark Directory as Excluded 可靠（手动标记会被 Sync 覆盖）。
idea {
    module {
        excludeDirs.addAll(
            listOf(
                file(".kotlin"),
                file(".intellijPlatform"),
                file(".zcode"),
                file("dist"),
                file("vendor/ZCode/node_modules"),
            ),
        )
    }
}

group = "dev.zcode.ide"
version = rootProject.property("pluginVersion") as String

repositories {
    maven("https://maven.aliyun.com/repository/public")
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        intellijDependencies()
    }
}

dependencies {
    intellijPlatform {
        create(
            rootProject.property("platformType") as String,
            rootProject.property("platformVersion") as String,
        )
        instrumentationTools()
        pluginVerifier()
        zipSigner()
    }

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

intellijPlatform {
    pluginConfiguration {
        id = "dev.zcode.ide"
        name = "ZCode IDE"
        version = project.version.toString()

        ideaVersion {
            sinceBuild = "251"
            untilBuild = "263.*"
        }
    }

    buildSearchableOptions = false
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}

// 薄/全开关：默认薄包（插件 zip 不含 runtime/，运行期由 RuntimeProvisioner 按需下载）；
// -PbundleRuntime=true 打完整包（行为与历史一致，供离线/内网安装使用）。
val bundleRuntime = providers.gradleProperty("bundleRuntime")
    .map(String::toBoolean)
    .orElse(false)

// 把 <repo>/dist（scripts/build-runtime.mjs 的输出）作为插件根目录下的 runtime/ 一起打包。
// buildPlugin 打包的是 prepareSandbox 生成的插件目录，所以在它之后、打包之前拷贝。
val runtimeDir = layout.projectDirectory.dir("dist")

val copyRuntimeToSandbox by tasks.registering {
    dependsOn(tasks.named("prepareSandbox"))
    outputs.upToDateWhen { false }

    doLast {
        val sandbox = layout.buildDirectory.dir("idea-sandbox").get().asFile
        val pluginDir = sandbox.walkTopDown().firstOrNull {
            it.isDirectory && it.name == "zcode-ide" && it.parentFile?.name == "plugins"
        } ?: error("prepareSandbox 未生成插件目录：$sandbox")
        val target = pluginDir.resolve("runtime")
        target.deleteRecursively()
        if (runtimeDir.asFile.exists()) {
            copy {
                from(runtimeDir)
                into(target)
            }
            logger.lifecycle("Bundled runtime → ${target.absolutePath}")
        } else {
            logger.warn("dist/ 不存在，跳过：先执行 node scripts/build-runtime.mjs")
        }
    }
}

// 薄包时清掉沙箱插件目录里可能残留的 runtime/：prepareSandbox 不会清空插件目录，
// 上一次 -PbundleRuntime=true 留下的 runtime/ 若不删除，会被薄 buildPlugin 原样打进 zip。
val stripRuntimeFromSandbox by tasks.registering {
    dependsOn(tasks.named("prepareSandbox"))
    outputs.upToDateWhen { false }

    doLast {
        val sandbox = layout.buildDirectory.dir("idea-sandbox").get().asFile
        val pluginDir = sandbox.walkTopDown().firstOrNull {
            it.isDirectory && it.name == "zcode-ide" && it.parentFile?.name == "plugins"
        } ?: return@doLast
        val target = pluginDir.resolve("runtime")
        if (target.exists()) {
            target.deleteRecursively()
            logger.lifecycle("Stripped stale runtime → ${target.absolutePath}")
        }
    }
}

// 仅完整包需要把 runtime 拷进沙箱；薄包（默认）反向清残留，保证 zip 里永远没有 runtime/。
if (bundleRuntime.get()) {
    tasks.named("buildPlugin") {
        dependsOn(copyRuntimeToSandbox)
    }
} else {
    tasks.named("buildPlugin") {
        dependsOn(stripRuntimeFromSandbox)
    }
}
