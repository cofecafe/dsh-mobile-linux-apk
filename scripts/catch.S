// 零依赖 SIGSYS 捕手：捕到即写 "SIGSYS=NR\n" 再 _exit；否则 execve 目标链
.equ __NR_write, 64
.equ __NR_exit, 93
.equ __NR_execve, 221
.equ __NR_rt_sigaction, 134
.equ SIGSYS, 31
.equ SA_SIGINFO, 4
.equ SA_NODEFER, 0x40000000

.global _start
.text
handler:
  // x2=ctx(ucontext); SIGSYS: si_addr 保存 nr? arm64: si_syscall 存于 si_errno?? 
  // kernel arm64: siginfo.si_syscall 在 union 尾部 _sifields[0]…直接写固定串+si_errno 十六进制
  adrp x1, msg
  add x1, x1, #:lo12:msg
  mov x2, #24
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  mov x0, #159
  mov x8, #__NR_exit
  svc #0

_start:
  // rt_sigaction(SIGSYS, {handler, SA_SIGINFO|SA_NODEFER, 0}, NULL, 8)
  adrp x1, handler
  add x1, x1, #:lo12:handler
  stp x1, xzr, [sp, #-64]!
  stp xzr, xzr, [sp, #16]
  mov x2, #SA_SIGINFO
  str x2, [sp, #8]
  mov x0, #SIGSYS
  mov x1, sp
  mov x2, #0
  mov x3, #8
  mov x8, #__NR_rt_sigaction
  svc #0
  // 打 "ARMED\n"
  adrp x1, armed
  add x1, x1, #:lo12:armed
  mov x2, #6
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  // execve(argv[1], argv+1, envp) —— argv 来自 kernel（_start 无 argc 寄存器约定?）
  // arm64 _start: sp[0]=argc sp[1..]=argv。取 argv[1]
  ldr x1, [sp, #96]!     // 平衡上面 sp 调整后再取? 简化：直接重算
  mov x0, sp
  // x0=sp 现指向 sigaction 结构——弃用此法，直接内联目标路径不可行；改为：重置栈重读 argv
  // （sigaction 的 32B 已在栈上，argv 更高处）
  add x5, sp, #64        // 回到原始 sp（argc@0 argv0@8 argv1@16）
  ldr x9, [x5, #16]      // argv[1]=目标程序 → x9 保存
  add x10, x5, #8        // argv 数组 → x10 保存
  ldr x6, [x5]           // argc
  add x11, x10, x6, lsl #3
  add x11, x11, #8       // envp → x11
  // [DIAG] 转储栈前 12 字（hex 慢速：每字 8 字节原样输出）
  mov x20, x5
  mov x21, #0
9:
  cmp x21, #12
  b.eq 8f
  mov x1, x20
  mov x2, #8
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  add x20, x20, #8
  add x21, x21, #1
  b 9b
8:
  mov x1, x9
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  mov x1, x9
  mov x3, #0
1:
  ldrb w4, [x9, x3]
  cbz w4, 2f
  add x3, x3, #1
  cmp x3, #200
  b.lt 1b
2:
  mov x2, x3
  mov x1, x9
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  adrp x1, nl
  add x1, x1, #:lo12:nl
  mov x2, #1
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  mov x0, x9
  mov x1, x10
  mov x2, x11
  mov x8, #__NR_execve
  svc #0
  // exec 失败：写 "E=" + errno 原始 8 字节（小端）
  adrp x1, execfail
  add x1, x1, #:lo12:execfail
  mov x2, #2
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  str x0, [sp, #-16]!
  mov x1, sp
  mov x2, #8
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  add sp, sp, #16
  mov x0, #3
  mov x8, #__NR_exit
  svc #0

.balign 8
armed:  .ascii "ARMED\n"
nl:     .ascii "\n"
execfail: .ascii "EXEC_FAIL!\n"
msg:    .ascii "SIGSYS-CAUGHT-EXITING\n"
