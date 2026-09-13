/*
 * d6-exec-hook.c — 4Debian D-6 启动器原型：glibc exec 族拦截器（libtermux-exec-ld-preload 的 glibc 孪生）。
 *
 * 问题（坑 97/98/101）：Android 内核在宿主命名空间解析 PT_INTERP——guest glibc 动态二进制
 * （PT_INTERP=/lib/ld-linux-aarch64.so.1）裸 execve 一律 ENOENT；guest 风格 shebang 同理。
 *
 * 机制：LD_PRELOAD 本钩子 → 拦截 execve/execv/execvp/execvpe/execl{,p,e}/posix_spawn{,p} →
 * 目标是「PT_INTERP 含 ld-linux 的 ELF」或「解释器落在 guest 树的 shebang 脚本」时，
 * 改写为 execve(D6_LDSO, [D6_LDSO, --argv0, argv0, <绝对路径>, 原 argv[1:]...], envp)。
 * ld.so 自身无 PT_INTERP（内核可直接 exec），LD_LIBRARY_PATH 随 env 传递 → 递归覆盖孙进程。
 *
 * 环境契约：
 *   D6_LDSO  — guest ld.so 的「当前命名空间」绝对路径（如 /data/local/tmp/g2/rootfs/usr/lib/.../ld-linux-aarch64.so.1）
 *   D6_ROOT  — guest 树根（PATH 命中 guest 工具时用于判归属 + 解析 shebang 解释器；可缺省=只按 PT_INTERP 判）
 *
 * 判定规则（保守：绝不碰宿主二进制）：
 *   ① ELF 且 PT_INTERP 字符串含 "ld-linux" → 包装（bionic 的 PT_INTERP=/system/bin/linker64 不含 → 不动）
 *   ② shebang 且解释器路径存在前缀 D6_ROOT → 包装（/system/*、/sbin/*、/vendor/* → 不动）
 *   ③ 其余（静态 ELF、宿主 ELF、无判定依据）→ 原样放行
 *
 * 编译（Debian 12 / gcc 12，目标各 ABI）：gcc -shared -fPIC -O2 -o libd6exec.so d6-exec-hook.c -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define D6_MAX_INTERP 128

static __thread int d6_busy = 0; /* 重入护栏（PATH 搜索期间自身不触发钩子路径） */

static const char *d6_ldso(void)
{
  const char *p = getenv("D6_LDSO");
  return (p && *p) ? p : NULL;
}

static const char *d6_root(void)
{
  const char *p = getenv("D6_ROOT");
  return (p && *p) ? p : "";
}

/* 解析 shebang 解释器（kernel 语义：#! 后首 token；可选单参数暂不支持——原型限制）。
 * 返回 malloc 的解释器绝对路径（必要时做 guest 重映射），失败 NULL。 */
static char *d6_shebang_interp(const unsigned char *buf, ssize_t n)
{
  char interp[D6_MAX_INTERP];
  int i = 2, j = 0;
  while (i < n && (buf[i] == ' ' || buf[i] == '\t')) i++;
  while (i < n && j < D6_MAX_INTERP - 1 && buf[i] != ' ' && buf[i] != '\t' && buf[i] != '\n') interp[j++] = buf[i++];
  interp[j] = 0;
  if (j == 0 || interp[0] != '/') return NULL;
  if (!strncmp(interp, "/system/", 8) || !strncmp(interp, "/sbin/", 6) || !strncmp(interp, "/vendor/", 8)) return NULL;
  const char *root = d6_root();
  struct stat st;
  if (root[0] != '\0' && (!strncmp(interp, "/bin/", 5) || !strncmp(interp, "/usr/", 5))) {
    char cand[D6_MAX_INTERP + 512];
    snprintf(cand, sizeof cand, "%s%s", root, interp);
    if (stat(cand, &st) == 0 && S_ISREG(st.st_mode)) return strdup(cand);
  }
  if (stat(interp, &st) == 0 && S_ISREG(st.st_mode)) return strdup(interp);
  if (root[0] != '\0') {
    char cand[D6_MAX_INTERP + 512];
    snprintf(cand, sizeof cand, "%s%s", root, interp);
    if (stat(cand, &st) == 0 && S_ISREG(st.st_mode)) return strdup(cand);
  }
  return NULL;
}

/* 判定 ELF 是否 guest glibc（PT_INTERP 含 ld-linux）。1=是 0=否 -1=读失败 */
/* ── syscall() 通用包装拦截（坑 104）─────────────────────────────────
 * Android 14 app 域 seccomp 对 io_uring_setup(425) 等 nr 级击杀；libuv 等经
 * libc 的 syscall(SYS_io_uring_setup, …) 动态调用——nr 无静态立即数，字节补丁
 * 无从下手。这里在 PLT 层拦 syscall()：命中高危 nr → 直接 -ENOSYS（调用方
 * 都有 ENOSYS 回退路径），不落入内核。435(clone3) 同理保险。
 */
long syscall(long nr, ...)
{
  static long (*real_syscall)(long, ...);
  long a[6] = {0, 0, 0, 0, 0, 0};
  va_list ap;
  va_start(ap, nr);
  for (int i = 0; i < 6; i++) a[i] = va_arg(ap, long);
  va_end(ap);
  if (nr == 425 || nr == 426 || nr == 427 /* io_uring* */ || nr == 435 /* clone3 */) {
    errno = ENOSYS;
    return -1;
  }
  if (!real_syscall) {
    real_syscall = (long (*)(long, ...))dlsym(RTLD_NEXT, "syscall");
    if (!real_syscall) return -1;
  }
  return real_syscall(nr, a[0], a[1], a[2], a[3], a[4], a[5]);
}

static int d6_is_glibc_elf(const char *abs)
{
  unsigned char buf[1024];
  int fd = open(abs, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, sizeof buf);
  close(fd);
  if (n < 64 || !(buf[0] == 0x7f && buf[1] == 'E' && buf[2] == 'L' && buf[3] == 'F')) return 0;
  if (buf[4] != 2) return 0; /* 只管 64 位 */
  uint16_t phoff, phentsize, phnum;
  memcpy(&phoff, buf + 32, 2);
  memcpy(&phentsize, buf + 54, 2);
  memcpy(&phnum, buf + 56, 2);
  for (int i = 0; i < phnum; i++) {
    size_t off = phoff + (size_t)i * phentsize;
    if (off + phentsize > (size_t)n || off + 56 > sizeof buf) break;
    uint32_t p_type, p_offset, p_filesz;
    memcpy(&p_type, buf + off, 4);
    memcpy(&p_offset, buf + off + 8, 4);
    memcpy(&p_filesz, buf + off + 32, 4);
    if (p_type != 3 /* PT_INTERP */) continue;
    if (p_offset < sizeof buf && p_offset + p_filesz <= sizeof buf)
      return strstr((char *)buf + p_offset, "ld-linux") != NULL ? 1 : 0;
    char interp[D6_MAX_INTERP];
    int f2 = open(abs, O_RDONLY | O_CLOEXEC);
    if (f2 < 0) return -1;
    ssize_t m = pread(f2, interp, sizeof interp - 1, p_offset);
    close(f2);
    if (m <= 0) return -1;
    interp[m] = 0;
    return strstr(interp, "ld-linux") != NULL ? 1 : 0;
  }
  return 0; /* 无 PT_INTERP = 静态 → 非 guest glibc */
}

/* 包装计划：目标需要包装时输出 prog（实际程序）与 extra（shebang 的脚本路径）。
 * 返回 1=需包装（*prog 已 malloc，*extra 可能 NULL）0=放行 -1=判定失败（按放行） */
static int d6_wrap_plan(const char *abs, char **prog, char **extra)
{
  *prog = NULL; *extra = NULL;
  unsigned char buf[2];
  int fd = open(abs, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, 2);
  close(fd);
  if (n == 2 && buf[0] == '#' && buf[1] == '!') {
    /* shebang：读首行取解释器，递归判定解释器是否 guest glibc ELF */
    unsigned char line[1024];
    fd = open(abs, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    n = read(fd, line, sizeof line);
    close(fd);
    if (n <= 2) return -1;
    char *interp = d6_shebang_interp(line, n);
    if (!interp) return 0; /* 宿主解释器（/system 等）或解析失败 → 交内核原生语义 */
    int ig = d6_is_glibc_elf(interp);
    if (ig == 1) { *prog = interp; *extra = strdup(abs); return 1; }
    free(interp);
    return 0;
  }
  /* 普通 ELF：guest glibc 判定 */
  int g = d6_is_glibc_elf(abs);
  if (g == 1) { *prog = strdup(abs); *extra = NULL; return 1; }
  return 0;
}

/* PATH 搜索（execvp/posix_spawnp 语义）+ 宿主缺失路径的 guest 重映射。
 * 返回 malloc 的绝对路径，找不到 NULL。
 * 重映射规则（D-6 启动器的最小命名空间模拟）：目标为 /bin/… 或 /usr/… 绝对路径且宿主上
 * 不存在、但 D6_ROOT 树内存在 → 返回 guest 树内路径（例：/bin/sh → $D6_ROOT/bin/sh，
 * node 的 execSync 硬编码 /bin/sh，Android 宿主无此路径——不重映射则第一跳即 ENOENT）。 */
static char *d6_path_search(const char *file)
{
  struct stat st;
  if (strchr(file, '/')) {
    /* guest 优先（/bin、/usr 前缀）：宿主的 /bin/sh 是 toybox（bionic，钩子管不进）——
     * 它替 guest 二进制 PATH 命中后自己裸 exec 必 ENOENT；让 /bin/sh 落到 guest dash
     * （glibc+preload → 递归受钩子管）整条链才闭合。/system、/vendor 等宿主域不碰。 */
    const char *root = d6_root();
    if (root[0] != '\0' && (!strncmp(file, "/bin/", 5) || !strncmp(file, "/usr/", 5))) {
      char cand[4096];
      snprintf(cand, sizeof cand, "%s%s", root, file);
      if (stat(cand, &st) == 0 && S_ISREG(st.st_mode) && access(cand, X_OK) == 0)
        return strdup(cand);
    }
    if (stat(file, &st) == 0 && S_ISREG(st.st_mode) && access(file, X_OK) == 0)
      return strdup(file);
    return NULL;
  }
  const char *path = getenv("PATH");
  if (!path || !*path) path = "/system/bin";
  char *copy = strdup(path), *save = NULL;
  for (char *dir = strtok_r(copy, ":", &save); dir; dir = strtok_r(NULL, ":", &save)) {
    char cand[4096];
    snprintf(cand, sizeof cand, "%s/%s", dir, file);
    if (stat(cand, &st) == 0 && S_ISREG(st.st_mode) && access(cand, X_OK) == 0) {
      free(copy);
      return strdup(cand);
    }
  }
  free(copy);
  return NULL;
}

/* 构造包装 argv：
 *   ELF：    [ldso, --argv0, argv0, prog, argv[1:]…]
 *   shebang：[ldso, --argv0, argv0, prog(=解释器), extra(=脚本), argv[1:]…]（kernel 语义近似） */
static char **d6_wrap_argv(const char *ldso, const char *prog, const char *extra, char *const argv[])
{
  int n = 0;
  while (argv[n]) n++;
  char **w = malloc(sizeof(char *) * (n + 6));
  int k = 0;
  w[k++] = (char *)ldso;
  w[k++] = "--argv0";
  w[k++] = argv[0] ? argv[0] : (char *)prog;
  w[k++] = (char *)prog;
  if (extra) w[k++] = (char *)extra;
  for (int i = 1; i < n; i++) w[k++] = argv[i];
  w[k] = NULL;
  return w;
}

/* ── execve ─────────────────────────────────────────────── */
int execve(const char *path, char *const argv[], char *const envp[])
{
  static int (*real)(const char *, char *const[], char *const[]);
  if (!real) real = dlsym(RTLD_NEXT, "execve");
  if (!d6_busy) {
    const char *ldso = d6_ldso();
    char *abs = d6_path_search(path);
    if (ldso && abs) {
      char *prog = NULL, *extra = NULL;
      d6_busy = 1;
      int wrap = d6_wrap_plan(abs, &prog, &extra);
      d6_busy = 0;
      if (wrap == 1) {
        char **w = d6_wrap_argv(ldso, prog, extra, argv);
        int rc = real(ldso, w, envp);
        free(w); free(prog); free(extra); free(abs);
        return rc;
      }
    }
    free(abs);
  }
  return real(path, argv, envp);
}

/* ── execv ──────────────────────────────────────────────── */
int execv(const char *path, char *const argv[])
{
  static int (*real)(const char *, char *const[]);
  if (!real) real = dlsym(RTLD_NEXT, "execv");
  if (!d6_busy) {
    const char *ldso = d6_ldso();
    char *abs = d6_path_search(path);
    if (ldso && abs) {
      char *prog = NULL, *extra = NULL;
      d6_busy = 1;
      int wrap = d6_wrap_plan(abs, &prog, &extra);
      d6_busy = 0;
      if (wrap == 1) {
        char **w = d6_wrap_argv(ldso, prog, extra, argv);
        extern char **environ;
        static int (*realve)(const char *, char *const[], char *const[]);
        if (!realve) realve = dlsym(RTLD_NEXT, "execve");
        int rc = realve(ldso, w, environ);
        free(w); free(prog); free(extra); free(abs);
        return rc;
      }
    }
    free(abs);
  }
  return real(path, argv);
}

/* ── execvp / execvpe ───────────────────────────────────── */
static int d6_execvp_impl(int (*realfn)(const char *, char *const[]), const char *file, char *const argv[])
{
  if (!d6_busy) {
    const char *ldso = d6_ldso();
    char *abs = d6_path_search(file);
    if (ldso && abs) {
      char *prog = NULL, *extra = NULL;
      d6_busy = 1;
      int wrap = d6_wrap_plan(abs, &prog, &extra);
      d6_busy = 0;
      if (wrap == 1) {
        char **w = d6_wrap_argv(ldso, prog, extra, argv);
        int rc = realfn(ldso, w); /* execvp(ldso,...)：ld.so 无 PT_INTERP，宿主内核直接可 exec */
        free(w); free(prog); free(extra); free(abs);
        return rc;
      }
    }
    free(abs);
  }
  return realfn(file, argv);
}
int execvp(const char *file, char *const argv[])
{
  static int (*real)(const char *, char *const[]);
  if (!real) real = dlsym(RTLD_NEXT, "execvp");
  return d6_execvp_impl(real, file, argv);
}
int execvpe(const char *file, char *const argv[], char *const envp[])
{
  static int (*real)(const char *, char *const[], char *const[]);
  if (!real) real = dlsym(RTLD_NEXT, "execvpe");
  if (!d6_busy) {
    const char *ldso = d6_ldso();
    char *abs = d6_path_search(file);
    if (ldso && abs) {
      char *prog = NULL, *extra = NULL;
      d6_busy = 1;
      int wrap = d6_wrap_plan(abs, &prog, &extra);
      d6_busy = 0;
      if (wrap == 1) {
        char **w = d6_wrap_argv(ldso, prog, extra, argv);
        int rc = real(ldso, w, envp);
        free(w); free(prog); free(extra); free(abs);
        return rc;
      }
    }
    free(abs);
  }
  return real(file, argv, envp);
}

/* ── execl 族（varargs → 重组 argv 后复用 execv/execve 路径）────────── */
int execl(const char *path, const char *arg0, ...)
{
  va_list ap; va_start(ap, arg0);
  char *argv[4096]; int n = 0;
  argv[n++] = (char *)arg0;
  while (argv[n - 1] && n < 4095) argv[n++] = va_arg(ap, char *);
  va_end(ap);
  return execv(path, argv);
}
int execlp(const char *file, const char *arg0, ...)
{
  va_list ap; va_start(ap, arg0);
  char *argv[4096]; int n = 0;
  argv[n++] = (char *)arg0;
  while (argv[n - 1] && n < 4095) argv[n++] = va_arg(ap, char *);
  va_end(ap);
  return execvp(file, argv);
}
int execle(const char *path, const char *arg0, ...)
{
  va_list ap; va_start(ap, arg0);
  char *argv[4096]; int n = 0;
  argv[n++] = (char *)arg0;
  while (argv[n - 1] && n < 4095) argv[n++] = va_arg(ap, char *);
  char **envp = va_arg(ap, char **);
  va_end(ap);
  extern int execve(const char *, char *const[], char *const[]);
  return execve(path, argv, envp);
}

/* ── posix_spawn / posix_spawnp（node/libuv 的实际路径）─────────────── */
static int d6_spawn_impl(int (*realfn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                                       const posix_spawnattr_t *, char *const[], char *const[]),
                         pid_t *pid, const char *file,
                         const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *attr,
                         char *const argv[], char *const envp[], int path_search)
{
  if (!d6_busy) {
    const char *ldso = d6_ldso();
    /* 两种变体统一走 d6_path_search：绝对路径含 /bin、/usr 宿主缺失重映射（如 /bin/sh） */
    char *abs = d6_path_search(file);
    if (ldso && abs) {
      char *prog = NULL, *extra = NULL;
      d6_busy = 1;
      int wrap = d6_wrap_plan(abs, &prog, &extra);
      d6_busy = 0;
      if (wrap == 1) {
        char **w = d6_wrap_argv(ldso, prog, extra, argv);
        int rc = realfn(pid, ldso, fa, attr, w, envp);
        free(w); free(prog); free(extra); free(abs);
        return rc;
      }
    }
    free(abs);
  }
  return realfn(pid, file, fa, attr, argv, envp);
}
/* 坑104 诊断：constructor 落盘标记（验证 LD_PRELOAD 是否真的预载进 app 域子进程） */
__attribute__((constructor))
static void d6_loaded_marker(void)
{
  const char *p = getenv("D6_LOADED_MARK");
  if (!p) return;
  int fd = open(p, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) { ssize_t r = write(fd, "H", 1); (void)r; close(fd); }
}

int posix_spawn(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
  static int (*real)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                     const posix_spawnattr_t *, char *const[], char *const[]);
  if (!real) real = dlsym(RTLD_NEXT, "posix_spawn");
  return d6_spawn_impl(real, pid, file, fa, attr, argv, envp, 0);
}
int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
  static int (*real)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                     const posix_spawnattr_t *, char *const[], char *const[]);
  if (!real) real = dlsym(RTLD_NEXT, "posix_spawnp");
  return d6_spawn_impl(real, pid, file, fa, attr, argv, envp, 1);
}
