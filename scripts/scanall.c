// nr=0..460 真参穷举：标记(nr十进制+\n)→syscall。最后标记+1=凶手。危险nr跳过。
// 编译：gcc -O2 -static -nostdlib -o scanall scanall.c（手写 syscalls，无 libc）
static char ob[16]; static long obn;
static void flushout(void) {
  register long x0 __asm__("x0") = 1;
  register long x1 __asm__("x1") = (long)ob;
  register long x2 __asm__("x2") = obn;
  register long x8 __asm__("x8") = 64;
  __asm__ volatile("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");
}
static void pr(long v) { // 十进制
  char t[12]; int n = 0;
  if (v == 0) t[n++] = '0';
  while (v > 0) { t[n++] = '0' + (v % 10); v /= 10; }
  obn = 0;
  for (int i = n - 1; i >= 0; i--) ob[obn++] = t[i];
  ob[obn++] = '\n'; flushout();
}
static long raw(long nr, long a, long b, long c, long d, long e, long f) {
  register long x0 __asm__("x0") = a, x1 __asm__("x1") = b, x2 __asm__("x2") = c,
                x3 __asm__("x3") = d, x4 __asm__("x4") = e, x5 __asm__("x5") = f,
                x8 __asm__("x8") = nr;
  __asm__ volatile("svc #0" : "+r"(x0) : "r"(x1),"r"(x2),"r"(x3),"r"(x4),"r"(x5),"r"(x8) : "memory");
  return x0;
}
static char pad1[64] __attribute__((aligned(64)));
static char pad2[64] __attribute__((aligned(64)));
static const long danger[] = {93,94,98,128,129,135,169,220,221,224,260,261,262,263,435,-1};
void _start(void) {
  for (long nr = 0; nr <= 460; nr++) {
    int bad = 0;
    for (int i = 0; danger[i] != -1; i++) if (danger[i] == nr) { bad = 1; break; }
    if (bad) continue;
    pr(nr);
    raw(nr, (long)pad1, 8, 0, 0, (long)pad2, 0);
  }
  obn = 0; ob[obn++]='D';ob[obn++]='O';ob[obn++]='N';ob[obn++]='E';ob[obn++]='\n'; flushout();
  raw(93, 0,0,0,0,0,0);
  for(;;);
}
