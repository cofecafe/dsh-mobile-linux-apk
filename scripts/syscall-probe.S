// seccomp 凶手定位 v2：先 syscall 后打字母。最后字母=最后幸存者；其后未打印者=凶手。
.global _start
.text
_start:
  stp x30, x19, [sp, #-16]!
  adrp x19, cand
  add x19, x19, #:lo12:cand
  adrp x22, letters
  add x22, x22, #:lo12:letters
  mov x20, #0
loop:
  ldr x21, [x19]
  cmp x21, #-1
  b.eq done
  // syscall(nr,0,0,0,0,0)
  mov x0, #0
  mov x1, #0
  mov x2, #0
  mov x3, #0
  mov x4, #0
  mov x5, #0
  mov x8, x21
  svc #0
  // 幸存 → 写字母 letters[x20]
  add x1, x22, x20
  mov x2, #1
  mov x0, #1
  mov x8, #64
  svc #0
  add x19, x19, #8
  add x20, x20, #1
  b loop
done:
  adrp x1, fin
  add x1, x1, #:lo12:fin
  mov x2, #9
  mov x0, #1
  mov x8, #64
  svc #0
  mov x0, #0
  mov x8, #93
  svc #0
.balign 8
cand:
  .quad 435, 436, 437, 438, 439, 440, 441, 442, 288, 270
  .quad 275, 276, 283, 284, 285, 286, 287, 289, 290, 291
  .quad 424, 425, 426, 427, 428, 429, 430, 431, 432, 433
  .quad -1
letters:
  .ascii "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"
fin: .ascii " ALLDONE\n"
