import { describe, expect, it } from 'vitest'
import { compileCcamProgramToRv32, compileCcamToRv32 } from './ccam-rv32'
import { formatProgram } from './ccam'
import { compile } from './compiler'
import { parse } from './parser'
import { assembleRv32, assembleRv32Line, createRv32Machine, runRv32 } from './riscv'

function wordsFromBytes(bytes: Uint8Array): number[] {
  const words: number[] = []
  for (let index = 0; index < bytes.length; index += 4) {
    words.push(readUint32(bytes, index))
  }
  return words
}

function readUint32(bytes: Uint8Array, address: number): number {
  return (bytes[address] | (bytes[address + 1] << 8) | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0
}

const initialEnvironmentPrologue = [
  '; prologue: initial environment push',
  'lw x5, 0(x2)',
  'addi x2, x2, -4',
  'sw x5, 0(x2)',
  '; prologue: initial environment cons',
  'lw x6, 4(x2)',
  'lw x7, 0(x2)',
  'sw x6, 0(x3)',
  'sw x7, 4(x3)',
  'sw x3, 4(x2)',
  'addi x2, x2, 4',
  'addi x3, x3, 8',
]

const epilogue = ['; epilogue', 'ebreak']
const push = ['; push', 'lw x5, 0(x2)', 'addi x2, x2, -4', 'sw x5, 0(x2)']
const app = [
  '; app',
  'lw x5, 0(x2)',
  'lw x6, 0(x5)',
  'lw x7, 4(x5)',
  'lw x5, 0(x6)',
  'lw x8, 4(x6)',
  'sw x5, 0(x3)',
  'sw x7, 4(x3)',
  'sw x3, 0(x2)',
  'addi x3, x3, 8',
  'addi x4, x4, -4',
  'sw x1, 0(x4)',
  'jalr x1, 0(x8)',
  '.Lccam_app_0_cont:',
  'lw x1, 0(x4)',
  'addi x4, x4, 4',
]
const quote6 = ['; \'6', 'addi x5, x0, 6', 'sw x5, 0(x3)', 'sw x3, 0(x2)', 'addi x3, x3, 4']
const quote7 = ['; \'7', 'addi x5, x0, 7', 'sw x5, 0(x3)', 'sw x3, 0(x2)', 'addi x3, x3, 4']
const quote8 = ['; \'8', 'addi x5, x0, 8', 'sw x5, 0(x3)', 'sw x3, 0(x2)', 'addi x3, x3, 4']
const quote1 = ['; \'1', 'addi x5, x0, 1', 'sw x5, 0(x3)', 'sw x3, 0(x2)', 'addi x3, x3, 4']
const swap = ['; swap', 'lw x5, 0(x2)', 'lw x6, 4(x2)', 'sw x6, 0(x2)', 'sw x5, 4(x2)']
const cons = [
  '; cons',
  'lw x6, 4(x2)',
  'lw x7, 0(x2)',
  'sw x6, 0(x3)',
  'sw x7, 4(x3)',
  'sw x3, 4(x2)',
  'addi x2, x2, 4',
  'addi x3, x3, 8',
]
const fst = ['; fst', 'lw x5, 0(x2)', 'lw x5, 0(x5)', 'sw x5, 0(x2)']
const snd = ['; snd', 'lw x5, 0(x2)', 'lw x5, 4(x5)', 'sw x5, 0(x2)']
const add = [
  '; add',
  'lw x5, 0(x2)',
  'lw x6, 0(x5)',
  'lw x7, 4(x5)',
  'lw x6, 0(x6)',
  'lw x7, 0(x7)',
  'add x6, x6, x7',
  'sw x6, 0(x3)',
  'sw x3, 0(x2)',
  'addi x3, x3, 4',
]
const sub = [
  '; sub',
  'lw x5, 0(x2)',
  'lw x6, 0(x5)',
  'lw x7, 4(x5)',
  'lw x6, 0(x6)',
  'lw x7, 0(x7)',
  'sub x6, x6, x7',
  'sw x6, 0(x3)',
  'sw x3, 0(x2)',
  'addi x3, x3, 4',
]
const curSnd = [
  '; Cur(snd)',
  'lw x5, 0(x2)',
  'sw x5, 0(x3)',
  '.Lccam_cur_0_addr:',
  'auipc x8, %pcrel_hi(.Lccam_cur_0_body)',
  'addi x8, x8, %pcrel_lo(.Lccam_cur_0_addr)',
  'sw x8, 4(x3)',
  'sw x3, 0(x2)',
  'addi x3, x3, 8',
]
const curSndBody = [
  '.Lccam_cur_0_body:',
  '; snd',
  'lw x5, 0(x2)',
  'lw x5, 4(x5)',
  'sw x5, 0(x2)',
  '; return',
  'jalr x0, 0(x1)',
]
const initialCodeHeapPointer = 0x00030000
const returnFooterWord = assembleRv32Line('jalr x0, 0(x1)')

function expectedRv32(...body: string[]): string {
  return [...initialEnvironmentPrologue, ...body, ...epilogue].join('\n')
}

function expectedRv32WithBodies(body: string[], ...bodies: string[][]): string {
  return [...initialEnvironmentPrologue, ...body, ...epilogue, ...bodies.flat()].join('\n')
}

function createCcamRv32Machine(rv32: string) {
  const memorySize = 256 * 1024
  const regs = new Uint32Array(32)
  regs[2] = memorySize - 4
  regs[3] = 0x00020000
  regs[4] = 0x0001fffc
  regs[9] = initialCodeHeapPointer
  return createRv32Machine(wordsFromBytes(assembleRv32(rv32)), { regs, memorySize })
}

describe('CCAM to RV32I compiler', () => {
  it('prepends an initial environment pair before the CCAM program', () => {
    const rv32 = compileCcamToRv32('.')
    const regs = new Uint32Array(32)
    regs[2] = 1020
    regs[3] = 0x100
    regs[4] = 0x0001fffc
    const state = createRv32Machine(wordsFromBytes(assembleRv32(rv32)), { regs, memorySize: 1024 })

    const steps = runRv32(state)

    const initialEnvironmentPointer = readUint32(state.memory, state.regs[2])
    expect(rv32).toBe(expectedRv32())
    expect(initialEnvironmentPointer).toBe(0x100)
    expect(readUint32(state.memory, initialEnvironmentPointer)).toBe(0xdeadbeef)
    expect(readUint32(state.memory, initialEnvironmentPointer + 4)).toBe(0xdeadbeef)
    expect(state.regs[2]).toBe(1020)
    expect(state.regs[3]).toBe(0x108)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles push', () => {
    expect(compileCcamToRv32('push')).toBe(expectedRv32(...push))
  })

  it('compiles integer quote', () => {
    expect(compileCcamToRv32("'6")).toBe(expectedRv32(...quote6))
  })

  it('compiles swap', () => {
    expect(compileCcamToRv32('swap')).toBe(expectedRv32(...swap))
  })

  it('compiles cons', () => {
    expect(compileCcamToRv32('cons')).toBe(expectedRv32(...cons))
  })

  it('compiles fst', () => {
    expect(compileCcamToRv32('fst')).toBe(expectedRv32(...fst))
  })

  it('compiles snd', () => {
    expect(compileCcamToRv32('snd')).toBe(expectedRv32(...snd))
  })

  it('compiles Cur with an out-of-line body after the main epilogue', () => {
    expect(compileCcamToRv32('Cur(snd)')).toBe(expectedRv32WithBodies(curSnd, curSndBody))
  })

  it('compiles app with a dedicated return stack continuation', () => {
    expect(compileCcamToRv32("push; Cur(snd); swap; '1; cons; app")).toBe(
      expectedRv32WithBodies([...push, ...curSnd, ...swap, ...quote1, ...cons, ...app], curSndBody),
    )
  })

  it('compiles add', () => {
    expect(compileCcamToRv32('add')).toBe(expectedRv32(...add))
  })

  it('compiles sub', () => {
    expect(compileCcamToRv32('sub')).toBe(expectedRv32(...sub))
  })

  it('compiles id as a no-op', () => {
    expect(compileCcamToRv32('id')).toBe(expectedRv32('; id'))
  })

  it('creates a native code block for arena', () => {
    const rv32 = compileCcamToRv32('arena')
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const blockPointer = readUint32(state.memory, state.regs[2])
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(blockPointer).toBe(0x00020008)
    expect(readUint32(state.memory, blockPointer)).toBe(initialCodeHeapPointer)
    expect(readUint32(state.memory, blockPointer + 4)).toBe(initialCodeHeapPointer)
    expect(readUint32(state.memory, initialCodeHeapPointer)).toBe(returnFooterWord)
    expect(state.regs[3]).toBe(0x00020010)
    expect(state.regs[9]).toBe(initialCodeHeapPointer + 4)
  })

  it("emits an integer quote snippet into a native code block", () => {
    const rv32 = compileCcamToRv32("push; arena; cons; emit('1)")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const pairPointer = readUint32(state.memory, state.regs[2])
    const blockPointer = readUint32(state.memory, pairPointer + 4)
    const cursorPointer = readUint32(state.memory, blockPointer + 4)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(cursorPointer).toBe(initialCodeHeapPointer + 16)
    expect(readUint32(state.memory, cursorPointer)).toBe(returnFooterWord)
    expect(state.regs[9]).toBe(initialCodeHeapPointer + 20)
    expect(readUint32(state.memory, initialCodeHeapPointer)).toBe(assembleRv32Line('addi x5, x0, 1'))
  })

  it('emits Stage 4 primitive snippets into a native code block', () => {
    const rv32 = compileCcamToRv32("push; arena; cons; emit(push); emit(fst); emit(snd); emit(swap); emit('8); emit(cons); emit(add)")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const pairPointer = readUint32(state.memory, state.regs[2])
    const blockPointer = readUint32(state.memory, pairPointer + 4)
    const cursorPointer = readUint32(state.memory, blockPointer + 4)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(readUint32(state.memory, initialCodeHeapPointer)).toBe(assembleRv32Line('lw x5, 0(x2)'))
    expect(readUint32(state.memory, initialCodeHeapPointer + 4)).toBe(assembleRv32Line('addi x2, x2, -4'))
    expect(readUint32(state.memory, initialCodeHeapPointer + 12)).toBe(assembleRv32Line('lw x5, 0(x2)'))
    expect(readUint32(state.memory, initialCodeHeapPointer + 16)).toBe(assembleRv32Line('lw x5, 0(x5)'))
    expect(readUint32(state.memory, initialCodeHeapPointer + 24)).toBe(assembleRv32Line('lw x5, 0(x2)'))
    expect(readUint32(state.memory, initialCodeHeapPointer + 116)).toBe(assembleRv32Line('add x6, x6, x7'))
    expect(readUint32(state.memory, cursorPointer)).toBe(returnFooterWord)
    expect(state.regs[9]).toBe(cursorPointer + 4)
  })

  it('lets a captured generator mutate the outer native code block', () => {
    const rv32 = compileCcamToRv32(
      "push; push; Cur(emit('1)); cons; Cur(push; push; fst; snd; swap; snd; cons; app; snd; swap); cons; push; snd; swap; arena; cons; app; snd",
    )
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const blockPointer = readUint32(state.memory, state.regs[2])
    const cursorPointer = readUint32(state.memory, blockPointer + 4)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(readUint32(state.memory, blockPointer)).toBe(initialCodeHeapPointer)
    expect(cursorPointer).toBe(initialCodeHeapPointer + 16)
    expect(readUint32(state.memory, initialCodeHeapPointer)).toBe(assembleRv32Line('addi x5, x0, 1'))
    expect(readUint32(state.memory, cursorPointer)).toBe(returnFooterWord)
    expect(state.regs[9]).toBe(initialCodeHeapPointer + 20)
  })

  it('lifts a value pointer into a native code block', () => {
    const rv32 = compileCcamToRv32("push; '42; Cur(lift); cons; push; snd; swap; arena; cons; app; snd")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const blockPointer = readUint32(state.memory, state.regs[2])
    const cursorPointer = readUint32(state.memory, blockPointer + 4)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(cursorPointer).toBe(initialCodeHeapPointer + 12)
    expect(readUint32(state.memory, initialCodeHeapPointer)).toBe(assembleRv32Line('lui x5, 131072'))
    expect(readUint32(state.memory, initialCodeHeapPointer + 4)).toBe(assembleRv32Line('addi x5, x5, 8'))
    expect(readUint32(state.memory, initialCodeHeapPointer + 8)).toBe(assembleRv32Line('sw x5, 0(x2)'))
    expect(readUint32(state.memory, cursorPointer)).toBe(returnFooterWord)
    expect(state.regs[9]).toBe(initialCodeHeapPointer + 16)
  })

  it('calls a native lifted value pointer block', () => {
    const rv32 = compileCcamToRv32("push; '42; Cur(lift); cons; push; snd; swap; arena; cons; app; call")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(42)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('calls a native generated code block and restores the return stack', () => {
    const rv32 = compileCcamToRv32('push; arena; cons; call')
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(state.regs[4]).toBe(0x0001fffc)
  })

  it('merges a callable generated closure body into a native code block', () => {
    const rv32 = compileCcamToRv32("push; arena; cons; push; push; fst; swap; arena; cons; emit(push); emit(snd); emit(swap); emit('10); emit(cons); emit(add); snd; swap; id; cons; merge; call; push; '11; cons; app")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(21)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('places merge bodies so later emits do not overwrite them', () => {
    const rv32 = compileCcamToRv32("push; arena; cons; push; push; fst; swap; arena; cons; emit(snd); snd; swap; id; cons; merge; emit('1)")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const pairPointer = readUint32(state.memory, state.regs[2])
    const blockPointer = readUint32(state.memory, pairPointer + 4)
    const cursorPointer = readUint32(state.memory, blockPointer + 4)
    const mergedClosureStart = initialCodeHeapPointer
    const finalQuoteStart = mergedClosureStart + 28
    const finalFooter = mergedClosureStart + 44
    const bodyCopyStart = initialCodeHeapPointer + 276
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(readUint32(state.memory, mergedClosureStart)).toBe(assembleRv32Line('lw x5, 0(x2)'))
    expect(readUint32(state.memory, bodyCopyStart)).toBe(assembleRv32Line('lw x5, 0(x2)'))
    expect(readUint32(state.memory, finalQuoteStart)).toBe(assembleRv32Line('addi x5, x0, 1'))
    expect(cursorPointer).toBe(finalFooter)
    expect(readUint32(state.memory, cursorPointer)).toBe(returnFooterWord)
    expect(state.regs[9]).toBe(cursorPointer + 4)
  })

  it('emits a callable generated closure body into a native code block', () => {
    const rv32 = compileCcamToRv32("push; arena; cons; emit(Cur(snd)); call; push; '1; cons; app")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('places emitted Cur bodies so later emits do not overwrite them', () => {
    const rv32 = compileCcamToRv32("push; arena; cons; emit(Cur(snd)); emit('1)")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const pairPointer = readUint32(state.memory, state.regs[2])
    const blockPointer = readUint32(state.memory, pairPointer + 4)
    const cursorPointer = readUint32(state.memory, blockPointer + 4)
    const bodyStart = initialCodeHeapPointer + 32
    const bodyFooter = bodyStart + 12
    const finalFooter = bodyFooter + 4
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(readUint32(state.memory, initialCodeHeapPointer + 28)).toBe(assembleRv32Line('jal x0, 20'))
    expect(readUint32(state.memory, bodyStart)).toBe(assembleRv32Line('lw x5, 0(x2)'))
    expect(readUint32(state.memory, bodyFooter)).toBe(returnFooterWord)
    expect(readUint32(state.memory, finalFooter)).toBe(assembleRv32Line('addi x5, x0, 1'))
    expect(cursorPointer).toBe(finalFooter + 16)
    expect(readUint32(state.memory, cursorPointer)).toBe(returnFooterWord)
    expect(state.regs[9]).toBe(cursorPointer + 4)
  })

  it('emits app into a native code block and restores the return stack', () => {
    const rv32 = compileCcamToRv32("push; arena; cons; emit(push); emit(Cur(snd)); emit(swap); emit('1); emit(cons); emit(app); call")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('creates a closure box for Cur without falling through to its body', () => {
    const rv32 = compileCcamToRv32('Cur(snd)')
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const initialEnvironmentPointer = 0x00020000
    const closurePointer = readUint32(state.memory, state.regs[2])
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
    expect(steps.at(-1)?.trap?.pc).toBe(68)
    expect(closurePointer).toBe(0x00020008)
    expect(readUint32(state.memory, closurePointer)).toBe(initialEnvironmentPointer)
    expect(readUint32(state.memory, closurePointer + 4)).toBe(72)
    expect(state.regs[3]).toBe(0x00020010)
  })

  it('uses unique labels for nested Cur bodies', () => {
    const rv32 = compileCcamToRv32('Cur(Cur(snd))')

    expect(rv32).toContain('.Lccam_cur_0_body:')
    expect(rv32).toContain('.Lccam_cur_1_body:')
    expect(rv32.indexOf('; epilogue')).toBeLessThan(rv32.indexOf('.Lccam_cur_1_body:'))
    expect(rv32.indexOf('; epilogue')).toBeLessThan(rv32.indexOf('.Lccam_cur_0_body:'))
    expect(() => assembleRv32(rv32)).not.toThrow()
  })

  it('selects the left side of a pair with fst', () => {
    const rv32 = compileCcamToRv32("push; '6; swap; '7; cons; fst")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(6)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('selects the right side of a pair with snd', () => {
    const rv32 = compileCcamToRv32("push; '6; swap; '7; cons; snd")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(7)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles a simple boxed integer addition CCAM program to RV32I assembly', () => {
    const source = "push; push; '6; swap; '7; cons; add; swap; '8; cons; add"
    const compiled = compileCcamToRv32(source)

    expect(compiled).toBe(
      expectedRv32(...push, ...push, ...quote6, ...swap, ...quote7, ...cons, ...add, ...swap, ...quote8, ...cons, ...add),
    )
    expect(() => assembleRv32(compiled)).not.toThrow()
  })

  it('subtracts boxed integers', () => {
    const rv32 = compileCcamToRv32("push; '9; swap; '4; cons; sub")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(5)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles the a + b sample through CCAM to RV32I and leaves a pointer to boxed 8 on the stack top', () => {
    const ast = parse('3 + 5')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(8)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles the a - b sample through CCAM to RV32I and leaves a pointer to boxed 5 on the stack top', () => {
    const ast = parse('9 - 4')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(5)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles the minimal code sample through CCAM to RV32I and leaves boxed 1 on the stack top', () => {
    const ast = parse('let cogen result = code 1 in result end')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles a captured code generator through CCAM to RV32I and leaves boxed 1 on the stack top', () => {
    const ast = parse('let cogen result = (let cogen u = code 1 in code u end) in result end')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(state.regs[9]).toBe(initialCodeHeapPointer + 20)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles the minimal lift sample through CCAM to RV32I and leaves boxed 42 on the stack top', () => {
    const ast = parse('let cogen result = lift 42 in result end')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(42)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles a lifted identity function through CCAM to RV32I and leaves boxed 3 on the stack top', () => {
    const ast = parse('let cogen result = lift (fn x => x) in result 3 end')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(3)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles a lifted code pipeline through CCAM to RV32I and leaves boxed 1 on the stack top', () => {
    const ast = parse('let cogen c0 = lift (code 1) in let cogen c1 = code c0 in let cogen c2 = c1 in c2 end end end')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles nested generated subtraction through CCAM to RV32I and leaves boxed -1 on the stack top', () => {
    const ast = parse('let cogen u = code (1 - 2) in let cogen v = code u in v end end')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(0xffffffff)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles nested let cogen inside code through CCAM to RV32I and leaves boxed 1 on the stack top', () => {
    const ast = parse('let cogen v = (code (let cogen u = code 1 in u end)) in v end')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles the Stage 4 merge and lift sample through CCAM to RV32I and leaves boxed 21 on the stack top', () => {
    const ast = parse(`let cogen generated = code (fn x => x + 10) in
  let cogen result = (
    let cogen a = lift (6 + 7) in
      code (a + 8)
    end
  ) in
    result
  end
end`)
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(21)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles the Stage 5 generated application sample through CCAM to RV32I and leaves boxed 1 on the stack top', () => {
    const ast = parse(`let cogen u = code ((fn x => x) 1) in
  u
end`)
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles nested generated code through CCAM to RV32I and leaves a generated-code closure on the stack top', () => {
    const ast = parse(`let cogen u = code (code 1) in
  u
end`)
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBeGreaterThanOrEqual(0x00020000)
    expect(readUint32(state.memory, stackTopPointer + 4)).toBeGreaterThan(0)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles lift inside generated code through CCAM to RV32I and leaves a generated-code closure on the stack top', () => {
    const ast = parse(`let cogen u = code (lift 1) in
  u
end`)
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBeGreaterThanOrEqual(0x00020000)
    expect(readUint32(state.memory, stackTopPointer + 4)).toBeGreaterThan(0)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles application inside a generated function through CCAM to RV32I and leaves boxed 1 on the stack top', () => {
    const ast = parse(`let cogen f = code (fn x => (fn y => y) x) in
  f 1
end`)
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('applies a CCAM closure and leaves a pointer to boxed 1 on the stack top', () => {
    const rv32 = compileCcamToRv32("push; Cur(snd); swap; '1; cons; app")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('compiles an ML identity application through CCAM to RV32I and leaves boxed 1 on the stack top', () => {
    const ast = parse('(fn x => x) 1')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('supports nested ML applications with the dedicated return stack', () => {
    const ast = parse('((fn f => f 1) (fn x => x))')
    const ccam = formatProgram(compile(ast).program)
    const rv32 = compileCcamToRv32(ccam)
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(1)
    expect(state.regs[4]).toBe(0x0001fffc)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('rejects unsupported CCAM instructions outside the parser surface', () => {
    expect(() => compileCcamProgramToRv32([{ op: 'bogus' } as never])).toThrow('Unsupported CCAM instruction')
  })

  it('rejects unsupported emitted CCAM instructions', () => {
    expect(() => compileCcamToRv32('emit(call)')).toThrow('Unsupported CCAM emit instruction')
  })

  it('compiles unit quotes as boxed placeholders', () => {
    const rv32 = compileCcamToRv32("'()")
    const state = createCcamRv32Machine(rv32)

    const steps = runRv32(state)

    const stackTopPointer = readUint32(state.memory, state.regs[2])
    expect(readUint32(state.memory, stackTopPointer)).toBe(0)
    expect(steps.at(-1)?.trap?.reason).toBe('ebreak')
  })

  it('rejects integer quotes outside the RV32I addi immediate range', () => {
    expect(() => compileCcamToRv32("'2048")).toThrow('out of RV32I addi immediate range')
  })
})
