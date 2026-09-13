package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.attribute.BasicFileAttributes

/**
 * Symbolic-link-safe filesystem primitives shared by the snapshot transaction and
 * the legacy user-data recovery. Every helper here is deliberately NOFOLLOW: a
 * dangling link inside the runtime tree is ordinary upgrade residue and must never
 * be resolved into the live tree, and a recursive delete must never escape through
 * a link into user data.
 */
internal object SnapshotFs {

  /** Existence without following a symbolic link. */
  fun exists(file: File): Boolean = Files.exists(file.toPath(), NOFOLLOW_LINKS)

  /** True when [file] is a symbolic link, dangling or not. */
  fun isSymbolicLink(file: File): Boolean = Files.isSymbolicLink(file.toPath())

  /** Deletes a file, directory or link without following links. */
  fun deletePath(path: File) {
    val nioPath = path.toPath()
    if (!Files.exists(nioPath, NOFOLLOW_LINKS)) return
    val attrs = Files.readAttributes(nioPath, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
    if (attrs.isDirectory) {
      try {
        Files.list(nioPath).use { children ->
          children.forEach { deletePath(it.toFile()) }
        }
      } catch (_: java.nio.file.NoSuchFileException) {
        // 并发回收竞态（4Debian 1GB 树实锤：EngineService 恢复线与启动流程线同时 deletePath
        // 同一 stage，后到者在迭代中条目已消失）——目录没了 = 对手已删完，视为成功。
        return
      }
    }
    try {
      Files.deleteIfExists(nioPath)
    } catch (_: java.nio.file.NoSuchFileException) {
      // 同上：消失即完成
    }
  }

  /** Rename within one filesystem; falls back to a plain move when ATOMIC_MOVE is unsupported. */
  fun move(source: File, destination: File) {
    destination.parentFile?.let { Files.createDirectories(it.toPath()) }
    try {
      Files.move(source.toPath(), destination.toPath(), ATOMIC_MOVE)
    } catch (_: AtomicMoveNotSupportedException) {
      Files.move(source.toPath(), destination.toPath())
    }
  }

  fun createDirectories(dir: File) {
    Files.createDirectories(dir.toPath())
  }
}
