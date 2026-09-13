// SIGSYS 捕手（4Debian 坑 104 诊断）：静态 PIE，无任何依赖。
// 用法：sigsys-probe <logfile> <prog> [args…] —— 捕 SIGSYS 时把 si_syscall 号写日志再 _exit(159)；
// 否则立刻 execve(prog)。seccomp 若是 KILL 模式则信号不可捕获（我们也就能下结论）。
// 编译：gcc -static-pie -O2 -o sigsys-probe sigsys-probe.c
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>

static void handler(int sig, siginfo_t *si, void *ctx) {
  (void)ctx;
  char buf[128];
  int n = snprintf(buf, sizeof buf, "SIGSYS caught: si_syscall=%d si_errno=%d code=%d\n",
                   si->si_syscall, si->si_errno, si->si_code);
  int fd = open(getenv("SIGSYS_LOG") ? getenv("SIGSYS_LOG") : "/data/local/tmp/sigsys.log",
                O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) { if (write(fd, buf, n) < 0) {} close(fd); }
  _exit(159);
  (void)sig;
}

int main(int argc, char **argv, char **envp) {
  if (argc < 3) { write(2, "usage: sigsys-probe PROG ARGS...\n", 32); return 2; }
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = handler;
  sa.sa_flags = SA_SIGINFO | SA_NODEFER;
  sigaction(SIGSYS, &sa, NULL);
  execve(argv[1], argv + 1, envp);
  write(2, "execve failed\n", 14);
  return 3;
}
