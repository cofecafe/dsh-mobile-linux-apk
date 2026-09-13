// 真参矩阵 v5：V8/libuv 启动嫌疑集。每测前打 2 字节编号+换行。
// 00=clone(SIGCHLD) 01=membarrier 02=mprotect 03=madvise 04=epoll_ctl
// 05=eventfd2 06=pipe2 07=sched_setaffinity 08=getcpu 09=clone(线程flags)
.equ __NR_write, 64
.equ __NR_exit, 93
.equ __NR_close, 57
.macro MARK n
  adrp x1, marks
  add x1, x1, #:lo12:marks
  add x1, x1, #\n
  mov x2, #3
  mov x0, #1
  mov x8, #__NR_write
  svc #0
.endm
.macro RET_C
  cmp x0, #0
  b.eq child_exit
.endm
.global _start
.text
_start:
  // 00: clone(SIGCHLD=17, stack=0, …) fork 语义
  MARK 0
  mov x0, #17
  mov x1, #0
  mov x2, #0
  mov x3, #0
  mov x4, #0
  mov x8, #220
  svc #0
  RET_C
  // 01: membarrier(1=PRIVATE_EXPEDITED, 0, 0)
  MARK 3
  mov x0, #1
  mov x1, #0
  mov x2, #0
  mov x8, #283
  svc #0
  // 02: mprotect(page, 0x1000, RW=3)
  MARK 6
  adrp x0, pagebuf
  add x0, x0, #:lo12:pagebuf
  mov x1, #0x1000
  mov x2, #3
  mov x8, #226
  svc #0
  // 03: madvise(page, 0x1000, 0=NORMAL)
  MARK 9
  adrp x0, pagebuf
  add x0, x0, #:lo12:pagebuf
  mov x1, #0x1000
  mov x2, #0
  mov x8, #233
  svc #0
  // 04: epoll_ctl(0, ADD=1, 0, 数据区)
  MARK 12
  mov x0, #0
  mov x1, #1
  mov x2, #0
  adrp x3, pagebuf
  add x3, x3, #:lo12:pagebuf
  mov x8, #21
  svc #0
  // 05: eventfd2(0, 0) → close
  MARK 15
  mov x0, #0
  mov x1, #0
  mov x8, #19
  svc #0
  mov x19, x0
  mov x0, x19
  mov x8, #57
  svc #0
  // 06: pipe2(数据区, 0) → close×2
  MARK 18
  adrp x0, pagebuf
  add x0, x0, #:lo12:pagebuf
  mov x1, #0
  mov x8, #59
  svc #0
  mov x0, #3
  mov x8, #57
  svc #0
  mov x0, #4
  mov x8, #57
  svc #0
  // 07: sched_setaffinity(0, 8, mask=数据区)
  MARK 21
  mov x0, #0
  mov x1, #8
  adrp x2, pagebuf
  add x2, x2, #:lo12:pagebuf
  mov x8, #122
  svc #0
  // 08: getcpu(数据区, 数据区+4, 0)
  MARK 24
  adrp x0, pagebuf
  add x0, x0, #:lo12:pagebuf
  add x1, x0, #4
  mov x2, #0
  mov x8, #168
  svc #0
  // 09: clone(线程flags=0x3d0f00, stack=数据区8K对齐, …) → 子即退
  MARK 27
  ldr x0, thrflags
  adrp x1, thrstack
  add x1, x1, #:lo12:thrstack
  mov x2, #0
  mov x3, #0
  mov x4, #0
  mov x8, #220
  svc #0
  RET_C
  // 全过
  adrp x1, done
  add x1, x1, #:lo12:done
  mov x2, #5
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  mov x0, #0
  mov x8, #__NR_exit
  svc #0
child_exit:
  mov x0, #0
  mov x8, #__NR_exit
  svc #0
.balign 4096
pagebuf: .zero 4096
.balign 4096
thrstack: .zero 16384
thrflags: .quad 0x3d0f00
marks: .ascii "00\n01\n02\n03\n04\n05\n06\n07\n08\n09\n"
done: .ascii "DONE\n"
