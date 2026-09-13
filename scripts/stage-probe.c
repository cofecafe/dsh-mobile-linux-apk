// 阶段测序器（坑 104 seccomp 二分）：app 域 spawn 本体后逐段推进并落痕。
// stage0 = 本进程静态 glibc init（死在这=极早期 init 撞过滤器）
// stage1 = write 标记；stage2 = fork+exec ld.so --version；stage3 = fork+exec node -e；
// stage4 = execve 全引擎链（本进程替换）。每阶段写 LOG 后再前进。
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>

static const char *LOGP;

static void mark(const char *s) {
  int fd = open(LOGP, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) { if (write(fd, s, strlen(s)) < 0) {} if (write(fd, "\n", 1) < 0) {} close(fd); }
}

static int run(char **argv) {
  pid_t p = fork();
  if (p == 0) {
    execve(argv[0], argv, environ);
    mark("EXEC_FAIL");
    _exit(127);
  }
  int st; waitpid(p, &st, 0);
  if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
  return WEXITSTATUS(st);
}

int main(int argc, char **argv, char **envp) {
  if (argc < 6) { write(2, "usage: stage-probe LOG LDSO NODE BINJS RROOT\n", 45); return 2; }
  LOGP = argv[1];
  const char *ldso = argv[2], *node = argv[3], *binjs = argv[4], *root = argv[5];
  char buf[256];
  mark("stage0-static-init-ok");
  mark("stage1-write-ok");
  char *a2[4]; a2[0] = (char *)ldso; a2[1] = (char *)"--argv0"; a2[2] = (char *)ldso; a2[3] = NULL;
  int r2 = run(a2);
  snprintf(buf, sizeof buf, "stage2-ldso-ver rc=%d", r2); mark(buf);
  char *a3[6]; a3[0] = (char *)ldso; a3[1] = (char *)"--argv0"; a3[2] = (char *)node; a3[3] = (char *)node;
  a3[4] = (char *)"-e"; a3[5] = NULL;
  // 注意：node -e 需要脚本参数；这里借 binjs 占位不跑引擎，仅 node 启动面
  char *a3b[7]; a3b[0]=a3[0]; a3b[1]=a3[1]; a3b[2]=a3[2]; a3b[3]=a3[3]; a3b[4]=(char*)"-e";
  a3b[5] = (char *)"process.stdout.write('N')"; a3b[6] = NULL;
  int r3 = run(a3b);
  snprintf(buf, sizeof buf, "stage3-node-e rc=%d", r3); mark(buf);
  (void)binjs; (void)root;
  mark("stage4-engine-exec");
  char *a4[9];
  a4[0] = (char *)ldso; a4[1] = (char *)"--argv0"; a4[2] = (char *)node; a4[3] = (char *)node;
  a4[4] = (char *)"--expose-internals"; a4[5] = (char *)binjs; a4[6] = (char *)"web";
  a4[7] = (char *)"--port"; a4[8] = NULL;
  // argv[6]=port
  static char *a4f[10];
  for (int i = 0; i < 9; i++) a4f[i] = a4[i];
  a4f[8] = argv[6]; a4f[9] = NULL;
  execve(a4f[0], a4f, envp);
  mark("stage4-EXEC_FAIL");
  return 3;
}
