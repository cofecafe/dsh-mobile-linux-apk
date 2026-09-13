// 真参数探测 v3：A=set_tid B=跳过 C=跳过 D=prctlVMA G=uname真参 E=clone3对照
.equ __NR_write, 64
.equ __NR_exit, 93
.macro PUTC idx
  adrp x1, chars
  add x1, x1, #:lo12:chars
  add x1, x1, #\idx
  mov x2, #1
  mov x0, #1
  mov x8, #__NR_write
  svc #0
.endm
.global _start
.text
_start:
  PUTC 0
  adrp x0, tidslot
  add x0, x0, #:lo12:tidslot
  mov x8, #96
  svc #0
  PUTC 1                       // B 位（99 已实锤，跳过）
  PUTC 2                       // C 位（293 已实锤，跳过）
  PUTC 3                       // D: prctl(PR_SET_VMA) 真参
  adrp x4, vmaname
  add x4, x4, #:lo12:vmaname
  adrp x2, tidslot
  add x2, x2, #:lo12:tidslot
  mov x3, #0x1000
  adrp x1, svmaval
  add x1, x1, #:lo12:svmaval
  ldr x1, [x1]
  mov x0, #0
  mov x8, #167
  svc #0
  PUTC 4                       // G: uname(真 buf) ← 本轮焦点
  adrp x0, unam
  add x0, x0, #:lo12:unam
  mov x8, #160
  svc #0
  PUTC 5                       // E: clone3(全零结构) 对照
  adrp x0, cl3args
  add x0, x0, #:lo12:cl3args
  mov x1, #64
  mov x8, #435
  svc #0
  PUTC 6                       // H: io_uring_setup(4, params真参)
  adrp x1, iour
  add x1, x1, #:lo12:iour
  mov x0, #4
  mov x8, #425
  svc #0
  PUTC 7                       // F: 全过
  adrp x1, done
  add x1, x1, #:lo12:done
  mov x2, #5
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  mov x0, #0
  mov x8, #__NR_exit
  svc #0
.balign 64
tidslot:  .zero 8
cl3args:  .zero 64
unam:     .zero 65
vmaname:  .ascii "d6probe\0"
svmaval:  .quad 0x53564d41
iour:     .zero 128
chars:    .ascii "ABCDEFGH"
done:     .ascii "DONE\n"
