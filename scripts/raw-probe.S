// 裸 syscall 探针：write(1,"RAWOK\n",6) + exit(0)，无任何运行时
.global _start
.text
_start:
  mov x0, #1
  adrp x1, msg
  add x1, x1, #0
  mov x2, #6
  mov x8, #64          // write
  svc #0
  mov x0, #0
  mov x8, #93          // exit
  svc #0
.balign 4096
msg: .ascii "RAWOK\n"
