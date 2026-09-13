// 真参穷举 v6：nr=0..460 先打十六进制标记再真参调用；最后标记的下一个 nr=凶手
.equ __NR_write, 64
.equ __NR_exit, 93
.global _start
.text
_start:
  mov x20, #0                    // nr
loop:
  cmp x20, #461
  b.hs finish
  // 危险表跳过 {93,94,169,220,221,224,260,261,262,263,435}
  adrp x1, dtable
  add x1, x1, #:lo12:dtable
  mov x19, #0
l1:
  ldr x3, [x1, x19, lsl #3]
  cmp x3, #-1
  b.eq safe
  cmp x3, x20
  b.eq next
  add x19, x19, #1
  b l1
safe:
  // 标记 = hex[nr>>4], hex[nr&15], '\n'
  adrp x1, hex
  add x1, x1, #:lo12:hex
  lsr x10, x20, #4
  and x11, x20, #15
  add x2, x1, x10
  ldrb w12, [x2]
  adrp x1, buf
  add x1, x1, #:lo12:buf
  strb w12, [x1]
  adrp x2, hex
  add x2, x2, #:lo12:hex
  add x2, x2, x11
  ldrb w12, [x2]
  strb w12, [x1, #1]
  mov w12, #10
  strb w12, [x1, #2]
  mov x2, #3
  mov x0, #1
  mov x8, #__NR_write
  svc #0
  // 真参：x0..x5=(ptr,8,0,0,ptr2,0)
  adrp x0, arg1
  add x0, x0, #:lo12:arg1
  mov x1, #8
  mov x2, #0
  mov x3, #0
  adrp x4, arg2
  add x4, x4, #:lo12:arg2
  mov x5, #0
  mov x8, x20
  svc #0
next:
  add x20, x20, #1
  b loop
finish:
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
arg1:  .zero 64
arg2:  .zero 64
hex:   .ascii "0123456789ABCDEF"
buf:   .zero 4
done:  .ascii "DONE\n"
.balign 8
dtable:
  .quad 93, 94, 169, 220, 221, 224, 260, 261, 262, 263, 435
  .quad -1
