# ML^box to CCAM to RV32I playground

このリポジトリは、ML^box の項を CCAM program にコンパイルし、CCAM emulator と RV32I emulator で観察するためのアプリケーションです。
画面は Playground と README のタブで構成されています。Playground では、ML^box source、CCAM compile trace、CCAM program、CCAM emulator、RV32I assembly、RV32I machine code、RV32I emulator を同じページ上で確認できます。

## ML^box to CCAM Program Compiler

ML^box source は `src/core/compiler.ts` の `compile(expr)` で CCAM program に変換されます。UI では `ML^box` パネルの入力から `CCAM Program (from ML^box)` と `ML^box to CCAM Compile Trace` が更新されます。

### Supported Source Forms

現在の compiler は次の ML^box forms を扱います。

- integer literal
- variable
- lambda, e.g. `fn x => x`
- application
- binary arithmetic: `+`, `-`
- `code`
- `lift`
- `let cogen`

Playground には、通常の算術・関数適用に加えて、`code` / `lift` / `let cogen` のサンプルが入っています。たとえば nested code substitution のサンプルとして、`let cogen u = code (1 - 2) in let cogen v = code u in v end end` は RV32I まで実行され、boxed `-1` を返します。

### Compile Trace

compile trace は、ML^box の judgement が段階的に CCAM instruction sequence へ展開される様子を表示します。最終行は `CCAM Program (from ML^box)` に入る CCAM program と一致します。

## CCAM Emulator

CCAM emulator は `src/core/ccam.ts` の `run(program)` で CCAM program を実行します。UI では実行結果の value と、各 step の stack / program transition を表示します。

### CCAM Program Syntax

`parseProgram(source: string)` は `;` 区切りの CCAM program を読み込みます。空 program は `.` と表記します。

対応している instruction は次の範囲です。

- `id`
- `fst`
- `snd`
- `push`
- `swap`
- `cons`
- `app`
- quote, e.g. `'6`, `'()`
- `Cur(program)`
- `emit(instruction)`
- `lift`
- `arena`
- `merge`
- `call`
- `add`
- `sub`

### Runtime Values

CCAM emulator は次の value を扱います。

- unit: `()`
- integer
- pair
- closure: captured environment と program
- block: generated CCAM program

## CCAM Program to RV32I Assembly Compiler

`src/core/ccam-rv32.ts` の `compileCcamToRv32(source: string): string` は、CCAM program の文字列を RV32I assembly の文字列に変換します。UI では `RV32I Assemble (from CCAM Program)` パネルに出力されます。

生成される RV32I assembly は、先頭に CCAM の初期環境を stack top に作る prologue を含みます。汎用 RV32I emulator の初期状態は変更せず、CCAM program to RV32I assembly compiler の出力だけがこの初期化を行います。

### Supported CCAM Instructions

RV32I assembly へのコンパイルに対応している CCAM instruction は次の範囲です。

- `id`
- `push`
- integer quote, e.g. `'6`
- `swap`
- `cons`
- `fst`
- `snd`
- `Cur(program)`
- `app`
- `arena`
- `emit(instruction)` for the generated-code subset described below
- `lift`
- `merge`
- `call`
- `add`
- `sub`

quote は integer value のみ対応しています。`'()` のような unit quote を RV32I compiler に渡すとエラーになります。

`emit(instruction)` が generated native code block に書き込める instruction は、`push`, integer quote, `swap`, `cons`, `fst`, `snd`, `Cur(program)`, `app`, `lift`, `add`, `sub` です。`merge` は stack top の body block と current block を含む環境を受け取り、body block を closure として current block に挿入します。それ以外の emitted instruction を渡すとエラーになります。

### Register Convention

CCAM program to RV32I assembly compiler は次の register convention を使います。

- `x0`: zero register
- `x1`: return address
- `x2`: CCAM runtime stack pointer
- `x3`: heap allocation pointer
- `x4`: dedicated return stack pointer
- `x5`: current pointer / pair pointer scratch
- `x6`: left scratch
- `x7`: right scratch
- `x8`: label address scratch
- `x9`: generated code heap pointer
- `x10`: rounded high immediate scratch
- `x11`: generated instruction word scratch
- `x12`: generated code cursor scratch

### Runtime Representation

CCAM program to RV32I assembly compiler は、すべての値を boxed object として扱います。CCAM runtime stack の各 slot は 32bit pointer です。

現在の object representation は tag なしです。

- int box: 32bit x 1
  - `0(ptr) = integer payload`
- pair box: 32bit x 2
  - `0(ptr) = left_ptr`
  - `4(ptr) = right_ptr`
- closure box: 32bit x 2
  - `0(ptr) = captured_env_ptr`
  - `4(ptr) = closure_entry_pc`
- block box: 32bit x 2
  - `0(ptr) = generated_code_entry_pc`
  - `4(ptr) = generated_code_cursor_pc`

CCAM の初期環境は pair box として heap に確保され、stack top にはその pointer が置かれます。現在は tag なし runtime の無効 pointer として、left/right の両方に `0xdeadbeef` を使います。

`'6` のような integer quote は、heap に 32bit の int box を確保し、その box への pointer を stack top に書きます。確保後、`x3` は 4 bytes 進みます。

`cons` は stack top から right pointer、その次から left pointer を取り、heap に pair box を確保します。その pair pointer を新しい stack top に置き、`x3` は 8 bytes 進みます。

`fst` は stack top の pair pointer から left pointer を読み、stack top をその pointer に置き換えます。`snd` は同じ形式で right pointer を読みます。

`Cur(program)` は heap に closure box を確保し、現在の stack top を captured environment として保存します。closure body は main program の `ebreak` 後ろに out-of-line の RV32I assembly として配置され、closure box にはその entry PC が保存されます。

`app` は stack top の `(closure, arg)` pair から captured environment と closure entry PC を読み、heap に `(captured_env, arg)` pair を作って closure body へ `jalr` します。入れ子呼び出しの戻り先は `x4` の dedicated return stack に保存します。

`arena` は data heap に block box を確保し、`x9` が指す generated code heap 上に return footer を置きます。block box の entry/cursor はどちらもこの footer を指し、`x9` は footer の直後へ進みます。

`emit(instruction)` は現在 stack top の `(env, block)` pair から block pointer を読み、block の cursor にある footer を native snippet で上書きします。snippet 末尾には新しい footer を置き、block cursor と `x9` を更新します。現在は integer quote に加えて、stack 操作、pair projection/construction、`add` / `sub`、生成された closure、生成コード内の `app` を emitted snippet として扱えます。

captured generator が `app` で呼ばれる場合も、引数として渡された同じ block box の cursor を更新します。そのため `let cogen u = code 1 in code u end` のような code variable substitution は、outer generator が作った block に inner generator の emitted code を追加します。

`call` は stack top の `(env, block)` pair から env と block pointer を読み、stack top を env に戻してから block の entry PC へ `jalr` します。RV32I 実装では、生成コードの結果を書き戻す slot として同じ物理 stack slot を再利用します。戻り先は `app` と同じく `x4` の dedicated return stack に保存します。

`add` と `sub` は stack top の pair pointer から left/right の int box pointer を読み、それぞれの integer payload を load して加算または減算します。結果は新しい int box として heap に確保し、その pointer を stack top に書きます。負の結果は 32bit word として保存されるため、`1 - 2` は `0xffffffff` になります。

### Limitations

現在の CCAM program to RV32I assembly compiler は、ML^box playground のサンプルを通すための最小 runtime です。

- `emit(call)`, `emit(arena)` など、generated-code subset 外の `emit` は未対応です。
- generated-code subset 外の instruction を `emit` することは未対応です。
- integer quote は RV32I `addi` の signed 12bit immediate 範囲、つまり `-2048..2047` に制限されています。
- object tag はまだありません。
- garbage collection はありません。

## RV32I Assembler

`src/core/riscv.ts` の `assembleRv32(source: string)` は RV32I assembly を bytecode に変換します。UI では assembler の結果を `RV32I Machine Code (from RV32I Assembly)` パネルに disassembly として表示します。

### Labels

`assembleRv32(source: string)` は RV32I assembly 内の labels を解決して bytecode に変換します。labels は命令 PC に対応づけられ、`jal` と branch 命令の PC-relative immediate に変換されます。

対応している label syntax は次の範囲です。

- label-only line, e.g. `target:`
- label + instruction line, e.g. `target: addi x1, x0, 1`
- `jal x1, target`
- branch label, e.g. `beq x1, x2, target`
- `auipc x1, %pcrel_hi(target)` with `addi x1, x1, %pcrel_lo(auipc_site_label)`

低レベル API の `assembleRv32Line(line: string)` は、これまで通り 1 行の RV32I instruction だけを受け取り、labels は受け取りません。

`%pcrel_hi(label)` / `%pcrel_lo(auipc_site_label)` 形式の assembler modifier は、GNU binutils の [RISC-V Assembler Modifiers](https://sourceware.org/binutils/docs/as/RISC_002dV_002dModifiers.html) を参考にしています。現時点の assembler が対応している modifier は、`auipc` + `addi` で PC-relative label address を作るための subset だけです。`la` などの擬似命令はまだ実装していません。

## RV32I Emulator

RV32I emulator は `src/core/riscv.ts` の `createRv32Machine(program, options)` と `stepRv32(state)` で RV32I machine state を実行します。UI では `RISC-V Emulator` パネルで assembly source、PC/status/last instruction、registers、disassembly、call stack、CCAM stack を確認できます。

### Initial State

RV32I emulator UI では、初期状態として memory と dedicated registers を設定します。

- memory size: `256 * 1024`
- `x2 = memory size - 4`
- `x3 = 0x00020000`
- `x4 = 0x0001fffc`
- `x9 = 0x00030000`

UI では `x1` / `x2` / `x3` / `x9` に、それぞれ `(Call Stack Pointer)` / `(CCAM Stack Pointer)` / `(Heap Head Pointer)` / `(Code Heap Pointer)` の補足ラベルを表示します。Call Stack パネルは `x4` の dedicated return stack pointer の周辺 memory を表示します。

### References

- [Run-time Code Generation and Modal-ML](https://dl.acm.org/doi/10.1145/277652.277727)
- [RV32I Base Integer Instruction Set](https://docs.riscv.org/reference/isa/unpriv/rv32.html)
