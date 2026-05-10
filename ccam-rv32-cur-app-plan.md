# CCAM -> RV32I App 対応計画

## Summary

未対応の `app` を RV32I コンパイラに追加する。

`app` は closure box から captured environment と entry PC を読み、closure entry へ `jalr` で移る。入れ子 application の return address 保存には dedicated return stack を使う。

## Stage 1: `app` + Dedicated Return Stack

専用 return stack を導入する。

- `x4`: return stack pointer
- return stack は通常 heap と別領域に予約する。
- emulator/test setup で `x4` を固定アドレスに初期化する。

推奨メモリ配置:

- RV32I program: `0x00000000` から配置する。
- Return Stack: `x4 = 0x0001fffc` から開始し、push ごとにより小さいアドレスへ伸びる。
- Heap: `x3 = 0x00020000` から開始し、allocation ごとにより大きいアドレスへ伸びる。
- Value Stack: `x2 = memory_size - 4` から開始し、push ごとにより小さいアドレスへ伸びる。

v1 では各領域の衝突検査は行わない。

`app` の動作:

- stack top の pair `(closure, arg)` を読む。
- closure から captured env と entry pc を読む。
- heap に `(captured_env, arg)` pair を作り、stack top に置く。
- continuation label の address を `x1` に作る。
- 現在の `x1` を return stack に push する。
- closure entry に `jalr x1, 0(entry_reg)` で移る。
- continuation label で return stack から caller の `x1` を pop する。

return stack push/pop:

```asm
; push
addi x4, x4, -4
sw x1, 0(x4)

; pop
lw x1, 0(x4)
addi x4, x4, 4
```

## Test Plan

- `push; Cur(snd); swap; '1; cons; app` が boxed `1` を返す。
- ML source `(fn x => x) 1` が boxed `1` を返す。
- nested call `((fn f => f 1) (fn x => x))` が boxed `1` を返す。
- 既存の `Cur`、`fst`/`snd`、label assembler、integer addition tests が regress しない。
- 実装時は `npm test` と `npm run build` を通す。

## Assumptions

- 今回の残り実装対象は `app`。
- closure entry address は closure box の `4(ptr)` に保存済み。
- `emit`/`lift`/`arena`/`merge`/`call`/`block` は後続対応に回す。
- return stack overflow/underflow の runtime check は v1 では入れない。
- object tag と garbage collection は入れない。
