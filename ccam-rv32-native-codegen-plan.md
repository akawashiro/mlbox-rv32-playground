# Native RV32I Codegen for CCAM Code Blocks

## Summary

- `code` / `emit` / `arena` / `call` を native RV32I codegen として実装する。
- Stage 1 で `let cogen result = code 1 in result end` を通す。
- Stage 2 で `let cogen result = (let cogen u = code 1 in code u end) in result end` を通す。
- Stage 3 で `let cogen result = lift 42 in result end` と `let cogen result = lift (fn x => x) in result 3 end` を通す。
- Stage 4 で `merge` と `lift` を含み、実行後 stack top が boxed integer `21` になる ML^box sample を通す。
- Generated block は CCAM bytecode ではなく、emulator memory 上の実行可能な RV32I instruction buffer として生成し、`call` で `jalr` 実行する。

## Stage 1: Minimal `code 1`

対象 ML^box:

```ml
let cogen result = code 1 in
  result
end
```

対象 CCAM:

```ccam
push; Cur(emit('1); snd); cons; snd; arena; cons; app; call
```

### Runtime Representation

- `block box` を data heap 上に `entry_pc` / `cursor_pc` の 2 words で表す。
- `x3` は data heap pointer として既存どおり使う。
- 新しく `x9` を generated code heap pointer として使う。
- UI/test 初期値は `x9 = 0x00030000` にする。
- Generated code buffer は emulator memory 上の通常 memory に置く。

### `arena`

- data heap に block box を確保する。
- `entry_pc` と `cursor_pc` に現在の `x9` を保存する。
- code buffer 先頭に return footer `jalr x0, 0(x1)` を書く。
- stack top に block pointer を置く。

### `emit('n)`

- 現在 stack top の `(env, block)` pair から block pointer を読む。
- block の `cursor_pc` にある footer を quote snippet で上書きする。
- quote snippet は既存 `quote` と同じ意味にする。
  - int box を data heap に確保する。
  - int box pointer を CCAM stack top に置く。
- snippet 末尾に新しい footer `jalr x0, 0(x1)` を書く。
- block の `cursor_pc` と `x9` を、新しい footer の直後まで進める。

### `call`

- stack top の block pointer を論理的に消費する。RV32I 実装では、生成コードの結果を書き戻す slot として同じ物理 stack slot を再利用する。
- block の `entry_pc` へ `jalr x1, 0(entry_pc)` する。
- `x1` は既存 `app` と同じ dedicated return stack `x4` に保存/復元する。
- generated code は footer `jalr x0, 0(x1)` で `call` continuation に戻る。

## Stage 2: Captured Generator `code u`

対象 ML^box:

```ml
let cogen result = (
  let cogen u = code 1 in
    code u
  end
) in
  result
end
```

対象 CCAM:

```ccam
push; push; Cur(emit('1); snd); cons; Cur(push; push; fst; snd; swap; snd; cons; app; swap; snd); cons; snd; arena; cons; app; call
```

### Required Behavior

- Stage 1 の `arena` / `emit('n)` / `call` をそのまま再利用する。
- `code u` の outer generator が、captured generator `u` に同じ block pointer を渡せることを保証する。
- Inner generator `Cur(emit('1); snd)` が `app` で呼ばれたとき、outer generator が作った同じ block box の `cursor_pc` を mutate する。
- Outer generator body の `push` / `fst` / `snd` / `swap` / `cons` / `app` は既存 RV32I コンパイル済み命令として動く想定なので、Stage 2 で新しい CCAM opcode は追加しない。
- Stage 2 は既存の native generator activation semantics で動き、acceptance test で block pointer の共有と cursor 更新が正しいことを固定する。

### Out of Scope for Stage 2

- `emit(push)`、`emit(app)`、`emit(add)` など、任意 CCAM instruction の native emission。
- `lift`
- `merge`
- general な generated function / nested generated code 全般。

## Stage 3: Minimal Pointer `lift`

対象 ML^box:

```ml
let cogen result = lift 42 in
  result
end
```

```ml
let cogen result = lift (fn x => x) in
  result 3
end
```

```ml
let cogen c0 = lift (code 1) in
  let cogen c1 = code c0 in
    let cogen c2 = c1 in
      c2
    end
  end
end
```

対象 CCAM:

```ccam
push; '42; Cur(lift; snd); cons; snd; arena; cons; app; call
```

```ccam
push; Cur(snd); Cur(lift; snd); cons; snd; arena; cons; app; call; swap; '3; cons; app
```

```ccam
push; Cur(emit('1); snd); Cur(lift; snd); cons; push; Cur(push; push; fst; snd; swap; snd; cons; app; swap; snd); cons; push; snd; arena; cons; app; call; cons; snd; arena; cons; app; call
```

### Required Behavior

- Stage 1/2 の `arena` / `call` をそのまま再利用する。
- `lift` を static CCAM instruction として RV32I にコンパイルする。
- `lift` は stack top の `(value, block)` pair から value pointer と block pointer を読み、現在 block に value pointer を復元する native snippet を追加する。
- `lift` が追加する snippet は、generated code 実行時に lifted value pointer を stack top に置く。
- lifted value は int に限定しない。normal closure pointer と code generator closure pointer も同じ pointer lift 方式で扱い、generated code の後続 `app` から呼び出せる。
- lifted code pipeline sample では、`code c0` / `c1` / `c2` の multi-hop captured generator activation が Stage 2 の block sharing と Stage 3 の pointer lift の組み合わせで動く。
- `lift 42` は既存 boxed int pointer を再利用し、fresh int box の再確保は要求しない。
- 対象 ML^box を ML^box to CCAM to RV32I で実行すると、最終 stack top は boxed integer `42` を指す。
- 対象 lifted identity function sample を ML^box to CCAM to RV32I で実行すると、最終 stack top は boxed integer `3` を指す。
- 対象 lifted code pipeline sample を ML^box to CCAM to RV32I で実行すると、最終 stack top は boxed integer `1` を指す。

### Out of Scope for Stage 3

- `emit(push)`、`emit(app)`、`emit(add)` など、任意 CCAM instruction の native emission。
- `merge`
- general な generated function / nested generated code 全般。

## Stage 4: Merge + Lift to Integer

対象 ML^box:

```ml
let cogen generated = code (fn x => x + 10) in
  let cogen result = (
    let cogen a = lift (6 + 7) in
      code (a + 8)
    end
  ) in
    result
  end
end
```

対象 CCAM:

```ccam
push; Cur(push; fst; arena; emit(push); emit(snd); emit(swap); emit('10); emit(cons); emit(add); snd; swap; id; cons; merge(Cur(push; snd; swap; '10; cons; add)); snd); cons; push; push; push; '6; swap; '7; cons; add; Cur(lift; snd); cons; Cur(emit(push); push; push; fst; snd; swap; snd; cons; app; swap; emit(swap); emit('8); emit(cons); emit(add); snd); cons; snd; arena; cons; app; call
```

### Required Behavior

- Stage 1/2/3 の `arena` / `emit('n)` / `call` / `lift` / captured generator block sharing をそのまま再利用する。
- `id` は static CCAM instruction として no-op RV32I にコンパイルする。
- `emit` は Stage 4 では `push` / `fst` / `snd` / `swap` / `cons` / `add` / integer quote を native RV32I snippet として生成できる。
- `merge(Cur(program))` は現在 block に closure creation snippet を追加し、closure body は generated code buffer に置く native RV32I body として生成する。
- `merge` の closure body は、現在 block の closure creation snippet と新しい footer より後ろに配置し、current block の追記で closure body を上書きしない。
- `merge` が生成した closure body も、既存 `app` と同じ `x4` dedicated return stack convention で戻る。
- 対象 ML^box を ML^box to CCAM to RV32I で実行すると、最終 stack top は boxed integer `21` を指す。

### Out of Scope for Stage 4

- `emit(app)`、`emit(call)`、`emit(arena)`、`emit(lift)`、`emit(merge(...))`、`emit(Cur(...))` の general 対応。
- nested generated code 全般。
- code buffer の容量チェック、GC、追加の executable permission model。
- Stage 4 対象 sample 以外の general な generated function 最適化。

## Stage 5: Generated Application

対象 ML^box:

```ml
let cogen u = code ((fn x => x) 1) in
  u
end
```

対象 CCAM:

```ccam
push; Cur(emit(push); emit(Cur(snd)); emit(swap); emit('1); emit(cons); emit(app); snd); cons; snd; arena; cons; app; call
```

### Required Behavior

- Stage 1/2/3/4 の `arena` / `call` / `lift` / `emit('n)` / `emit(push)` / `emit(swap)` / `emit(cons)` / generated closure body 配置をそのまま再利用する。
- `emit(Cur(program))` は現在 block に closure creation snippet を追加し、closure body は current block の新しい footer より後ろに配置する。
- `emit(app)` は既存 static `app` と同じ native snippet を現在 block に追加し、generated code 内から closure を呼び出せる。
- `emit(Cur(...))` と `emit(app)` は既存 `x4` dedicated return stack convention で戻る。
- 対象 ML^box を ML^box to CCAM to RV32I で実行すると、最終 stack top は boxed integer `1` を指す。

### Out of Scope for Stage 5

- `emit(call)`、`emit(arena)`、`emit(lift)`、`emit(merge(...))` の general 対応。
- nested generated code 全般。
- code buffer の容量チェック、GC、追加の executable permission model。
- Stage 5 対象 sample 以外の general な generated application 最適化。

## Implementation Notes

- `compileInstruction` に `arena`、`emit`、`call` を追加する。
- `compileInstruction` に Stage 3 で `lift` を追加する。
- `compileInstruction` に Stage 4 で `id`、`merge` を追加する。
- Stage 5 で `emit(Cur(...))` と `emit(app)` を追加する。
- `emit` は Stage 1/2/3 では integer quote のみ対応し、Stage 4 で `push` / `fst` / `snd` / `swap` / `cons` / `add` / integer quote に拡張する。
- Stage 5 で `emit(Cur(...))` / `emit(app)` に拡張する。
- Stage 4 の対応外 instruction を含む `emit(...)` は明示的な unsupported error にする。
- Runtime に instruction word を書く helper を追加する。
  - Compile-time に `assembleRv32Line(...)` で RV32I instruction word を作る。
  - Runtime assembly は `lui` / `addi` / `sw` で 32-bit word を memory に書く。
- `emit` / `lift` / `merge` は、現在 block の footer を generated snippet で上書きし、snippet 末尾に新しい return footer `jalr x0, 0(x1)` を書き直す。Stage 3 では `lift`、Stage 4 では `emit` / `merge` もこの方式を使う。
- block の `cursor_pc` と `x9` は、新しい footer の直後まで進める。
- `merge(Cur(program))` / `emit(Cur(program))` は closure body を先に `x9` へ置かない。安全な配置順序は次の通りに固定する。
  - 現在 block の `cursor_pc` を `C` とする。
  - closure creation snippet の byte size を compile-time に決める。
  - `C` から closure creation snippet を書く。
  - closure creation snippet の直後に `jal x0, after_body` を書き、block 実行時に closure body へ fallthrough しない。
  - closure body はその jump の直後から書く。
  - closure body 末尾にも return footer `jalr x0, 0(x1)` を書く。
  - `after_body` に現在 block の新しい footer `jalr x0, 0(x1)` を書く。
  - 現在 block の `cursor_pc` は `after_body` footer 位置に更新する。
  - `x9` は `after_body` footer の直後に更新する。
- Generated code heap の不変条件は次の通りにする。
  - `cursor_pc` は、その block の現在 footer 位置を指す。
  - `x9` は、すべての generated code allocation の最高使用アドレスの直後を指す。
  - `merge` / `emit(Cur(...))` は current block snippet と closure body の両方を考慮して `x9` を進める。
  - data heap 上の block box は code heap write では変更しない。block box の変更は `cursor_pc` word の更新だけに限定する。
- README の register convention / runtime representation / limitations に `x9`、block box、native generated code buffer を反映する。

## Test Plan

### Unit Tests

- `arena` が block box と footer を作る。
- `emit('1)` が footer を quote snippet に置き換え、cursor と `x9` を進める。
- `call` が generated code に jump し、`x4` を元に戻す。
- `lift` が現在値 pointer を復元する snippet として現在 block に追加し、cursor と `x9` を進める。
- `id` が no-op RV32I として compile される。
- `emit(push)` / `emit(fst)` / `emit(snd)` / `emit(swap)` / `emit(cons)` / `emit(add)` / `emit('n)` が native snippet を block に追加し、cursor と `x9` を進める。
- `merge(Cur(push; snd; swap; '10; cons; add))` が closure creation snippet と callable generated closure body を生成する。
- `merge(Cur(...))` 後、current block footer、closure body entry、closure body footer、`x9` がこの順に並ぶ。
- `emit(Cur(snd))` が closure creation snippet と callable generated closure body を生成する。
- `emit(app)` が generated code 内から closure を呼び出せる。
- 2 回連続の `merge`、および `emit` 後の `merge` で、前の block code/body が後続書き込みで上書きされない。
- Stage 4 までは unsupported `emit(app)` が明示的な unsupported error になる。

### End-to-End Tests

- `let cogen result = code 1 in result end` を ML^box to CCAM to RV32I で実行し、stack top が boxed `1` を指すこと。
- `let cogen result = (let cogen u = code 1 in code u end) in result end` を ML^box to CCAM to RV32I で実行し、stack top が boxed `1` を指すこと。
- `let cogen result = lift 42 in result end` を ML^box to CCAM to RV32I で実行し、stack top が boxed `42` を指すこと。
- `let cogen result = lift (fn x => x) in result 3 end` を ML^box to CCAM to RV32I で実行し、stack top が boxed `3` を指すこと。
- `let cogen c0 = lift (code 1) in let cogen c1 = code c0 in let cogen c2 = c1 in c2 end end end` を ML^box to CCAM to RV32I で実行し、stack top が boxed `1` を指すこと。
- Stage 4 対象 ML^box を ML^box to CCAM to RV32I で実行し、stack top が boxed `21` を指すこと。
- `let cogen u = code ((fn x => x) 1) in u end` を ML^box to CCAM to RV32I で実行し、stack top が boxed `1` を指すこと。
- 既存の `3 + 5`、lambda application、nested application tests が regress しないこと。

### Verification Commands

```sh
npm test
npm run build
npm run lint
```

## Assumptions

- Generated code buffer は通常 emulator memory に置き、追加の executable permission model は入れない。
- Code heap は固定初期値 `0x00030000` から上方向に伸ばす。
- 小サンプル向け実装では容量チェックは追加せず、out-of-bounds は既存 emulator trap に任せる。
- 容量チェックは追加しないが、`merge` の配置順序による自己上書きは Stage 4 の範囲で防ぐ。
- Stage 2 は captured generator が同じ block pointer を mutate できることを目的にし、general な `emit(<任意 instruction>)` 対応は後続作業に分ける。
- Stage 3 は pointer lift により `lift 42`、lifted identity function sample、lifted code pipeline sample を通すための範囲に限定する。
- Stage 4 は対象 sample を通すための最小 native codegen 範囲に限定し、最終値は raw integer ではなく既存 runtime と同じ boxed integer pointer として stack top に置く。
- Stage 5 は generated application sample を通すための最小 native codegen 範囲に限定する。

## 実装状況

- Stage 1: 実装完了。`arena` / `emit('n)` / `call` が実装済みで、`let cogen result = code 1 in result end` の E2E test が通る状態。
- Stage 2: 実装完了。captured generator が outer native code block を mutate でき、`let cogen result = (let cogen u = code 1 in code u end) in result end` の E2E test が通る状態。
- Stage 3: 実装完了。pointer `lift` が RV32I compiler 側で実装済みで、`lift 42`、lifted identity function、lifted code pipeline の E2E test が通る状態。
- Stage 4: 実装完了。`id` / `merge(Cur(...))` / `emit(push)` / `emit(fst)` / `emit(snd)` / `emit(swap)` / `emit(cons)` / `emit(add)` / `emit('n)` が実装済みで、Stage 4 merge + lift sample の E2E test が boxed `21` を返す状態。
- Stage 5: 実装完了。`emit(Cur(...))` / `emit(app)` が実装済みで、generated application sample の E2E test が boxed `1` を返す状態。
