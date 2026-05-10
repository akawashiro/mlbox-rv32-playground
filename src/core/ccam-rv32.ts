import type { Instruction, Value } from './ccam'
import { formatInstruction, parseProgram } from './ccam'
import { assembleRv32Line } from './riscv'

const sp = 'x2'
const heap = 'x3'
const pairPointer = 'x5'
const left = 'x6'
const right = 'x7'
const labelAddress = 'x8'
const codeHeap = 'x9'
const returnAddress = 'x1'
const returnStack = 'x4'
const roundedHigh = 'x10'
const instructionWord = 'x11'
const cursor = 'x12'
const endTrapInstruction = 'ebreak'
const returnFooter = `jalr x0, 0(${returnAddress})`
const liftLuiBaseWord = (5 << 7) | 0x37
const liftAddiBaseWord = (5 << 15) | (5 << 7) | 0x13

type CompileContext = {
  closureBodies: string[][]
  nextClosureId: number
  nextApplicationId: number
}

type GeneratedSnippet = {
  lines: string[]
  cursorOffset: number
}

export function compileCcamToRv32(source: string): string {
  return compileCcamProgramToRv32(parseProgram(source))
}

export function compileCcamProgramToRv32(program: Instruction[]): string {
  const context: CompileContext = { closureBodies: [], nextClosureId: 0, nextApplicationId: 0 }
  const main = program.flatMap((instruction) => compileCommentedInstruction(instruction, context))
  return [
    ...compileInitialEnvironment(context),
    ...main,
    '; epilogue',
    endTrapInstruction,
    ...context.closureBodies.flat(),
  ].join('\n')
}

function compileInitialEnvironment(context: CompileContext): string[] {
  return [
    '; prologue: initial environment push',
    ...compileInstruction({ op: 'push' }, context),
    '; prologue: initial environment cons',
    ...compileInstruction({ op: 'cons' }, context),
  ]
}

function compileCommentedInstruction(instruction: Instruction, context: CompileContext): string[] {
  return [`; ${formatInstruction(instruction)}`, ...compileInstruction(instruction, context)]
}

function compileInstruction(instruction: Instruction, context: CompileContext): string[] {
  switch (instruction.op) {
    case 'id':
      return []
    case 'push':
      return [`lw ${pairPointer}, 0(${sp})`, `addi ${sp}, ${sp}, -4`, `sw ${pairPointer}, 0(${sp})`]
    case 'quote':
      return compileQuote(instruction.value)
    case 'swap':
      return [
        `lw ${pairPointer}, 0(${sp})`,
        `lw ${left}, 4(${sp})`,
        `sw ${left}, 0(${sp})`,
        `sw ${pairPointer}, 4(${sp})`,
      ]
    case 'cons':
      return [
        `lw ${left}, 4(${sp})`,
        `lw ${right}, 0(${sp})`,
        `sw ${left}, 0(${heap})`,
        `sw ${right}, 4(${heap})`,
        `sw ${heap}, 4(${sp})`,
        `addi ${sp}, ${sp}, 4`,
        `addi ${heap}, ${heap}, 8`,
      ]
    case 'fst':
      return [`lw ${pairPointer}, 0(${sp})`, `lw ${pairPointer}, 0(${pairPointer})`, `sw ${pairPointer}, 0(${sp})`]
    case 'snd':
      return [`lw ${pairPointer}, 0(${sp})`, `lw ${pairPointer}, 4(${pairPointer})`, `sw ${pairPointer}, 0(${sp})`]
    case 'cur':
      return compileCur(instruction.program, context)
    case 'app':
      return compileApp(context)
    case 'add':
    case 'sub':
      return compileIntegerBinary(instruction.op)
    case 'arena':
      return compileArena()
    case 'emit':
      return compileEmit(instruction.instruction)
    case 'lift':
      return compileLift()
    case 'merge':
      return compileMerge(instruction.program)
    case 'call':
      return compileCall(context)
    default:
      return assertUnsupportedInstruction(instruction)
  }
}

function compileIntegerBinary(op: 'add' | 'sub'): string[] {
  return [
    `lw ${pairPointer}, 0(${sp})`,
    `lw ${left}, 0(${pairPointer})`,
    `lw ${right}, 4(${pairPointer})`,
    `lw ${left}, 0(${left})`,
    `lw ${right}, 0(${right})`,
    `${op} ${left}, ${left}, ${right}`,
    `sw ${left}, 0(${heap})`,
    `sw ${heap}, 0(${sp})`,
    `addi ${heap}, ${heap}, 4`,
  ]
}

function compileArena(): string[] {
  return [
    `sw ${codeHeap}, 0(${heap})`,
    `sw ${codeHeap}, 4(${heap})`,
    ...storeInstructionWord(codeHeap, 0, rv32Word(returnFooter)),
    `addi ${sp}, ${sp}, -4`,
    `sw ${heap}, 0(${sp})`,
    `addi ${heap}, ${heap}, 8`,
    `addi ${codeHeap}, ${codeHeap}, 4`,
  ]
}

function compileEmit(instruction: Instruction): string[] {
  const snippet = compileEmittedSnippet(instruction)

  return [
    `lw ${pairPointer}, 0(${sp})`,
    `lw ${left}, 4(${pairPointer})`,
    `lw ${right}, 4(${left})`,
    ...compileGeneratedSnippet(right, snippet.lines),
    `addi ${pairPointer}, ${right}, ${snippet.cursorOffset}`,
    `sw ${pairPointer}, 4(${left})`,
    `addi ${codeHeap}, ${right}, ${snippet.lines.length * 4}`,
  ]
}

function compileMerge(program: Instruction[]): string[] {
  const snippet = compileGeneratedClosureSnippet(program)

  return [
    `lw ${pairPointer}, 0(${sp})`,
    `lw ${left}, 4(${pairPointer})`,
    `lw ${cursor}, 4(${left})`,
    ...compileGeneratedSnippet(cursor, snippet.lines),
    `addi ${pairPointer}, ${cursor}, ${snippet.cursorOffset}`,
    `sw ${pairPointer}, 4(${left})`,
    `addi ${codeHeap}, ${cursor}, ${snippet.lines.length * 4}`,
  ]
}

function compileEmittedSnippet(instruction: Instruction): GeneratedSnippet {
  if (instruction.op === 'cur') return compileGeneratedClosureSnippet(instruction.program)

  const snippetBody = compileGeneratedInstruction(instruction, 'emit')
  return {
    lines: [...snippetBody, returnFooter],
    cursorOffset: snippetBody.length * 4,
  }
}

function compileGeneratedClosureSnippet(program: Instruction[], includeContinuationReturn = true): GeneratedSnippet {
  const body = [
    ...program.flatMap((instruction) => compileGeneratedInstruction(instruction, 'merge')),
    returnFooter,
  ]
  const creation = [
    `lw ${pairPointer}, 0(${sp})`,
    `sw ${pairPointer}, 0(${heap})`,
    `auipc ${labelAddress}, 0`,
    `addi ${labelAddress}, ${labelAddress}, 24`,
    `sw ${labelAddress}, 4(${heap})`,
    `sw ${heap}, 0(${sp})`,
    `addi ${heap}, ${heap}, 8`,
  ]
  const jumpOffset = (1 + body.length) * 4
  const lines = [...creation, `jal x0, ${jumpOffset}`, ...body, ...(includeContinuationReturn ? [returnFooter] : [])]

  return {
    lines,
    cursorOffset: includeContinuationReturn ? (lines.length - 1) * 4 : lines.length * 4,
  }
}

function compileGeneratedInstruction(instruction: Instruction, source: 'emit' | 'merge'): string[] {
  switch (instruction.op) {
    case 'id':
      if (source === 'emit') break
      return []
    case 'push':
      return [`lw ${pairPointer}, 0(${sp})`, `addi ${sp}, ${sp}, -4`, `sw ${pairPointer}, 0(${sp})`]
    case 'quote':
      return compileQuote(instruction.value)
    case 'swap':
      return [
        `lw ${pairPointer}, 0(${sp})`,
        `lw ${left}, 4(${sp})`,
        `sw ${left}, 0(${sp})`,
        `sw ${pairPointer}, 4(${sp})`,
      ]
    case 'cons':
      return [
        `lw ${left}, 4(${sp})`,
        `lw ${right}, 0(${sp})`,
        `sw ${left}, 0(${heap})`,
        `sw ${right}, 4(${heap})`,
        `sw ${heap}, 4(${sp})`,
        `addi ${sp}, ${sp}, 4`,
        `addi ${heap}, ${heap}, 8`,
      ]
    case 'fst':
      return [`lw ${pairPointer}, 0(${sp})`, `lw ${pairPointer}, 0(${pairPointer})`, `sw ${pairPointer}, 0(${sp})`]
    case 'snd':
      return [`lw ${pairPointer}, 0(${sp})`, `lw ${pairPointer}, 4(${pairPointer})`, `sw ${pairPointer}, 0(${sp})`]
    case 'cur':
      return compileGeneratedClosureSnippet(instruction.program, false).lines
    case 'add':
    case 'sub':
      return compileIntegerBinary(instruction.op)
    case 'arena':
      if (source === 'merge') return compileArena()
      break
    case 'lift':
      if (source === 'merge') return compileLift()
      break
    case 'app':
      return compileGeneratedApp()
  }

  const instructionKind = source === 'emit' ? 'emit instruction' : 'merge body instruction'
  throw new Error(`Unsupported CCAM ${instructionKind} for RV32I compilation: ${formatInstruction(instruction)}`)
}

function compileGeneratedApp(): string[] {
  return [
    `lw ${pairPointer}, 0(${sp})`,
    `lw ${left}, 0(${pairPointer})`,
    `lw ${right}, 4(${pairPointer})`,
    `lw ${pairPointer}, 0(${left})`,
    `lw ${labelAddress}, 4(${left})`,
    `sw ${pairPointer}, 0(${heap})`,
    `sw ${right}, 4(${heap})`,
    `sw ${heap}, 0(${sp})`,
    `addi ${heap}, ${heap}, 8`,
    `addi ${returnStack}, ${returnStack}, -4`,
    `sw ${returnAddress}, 0(${returnStack})`,
    `jalr ${returnAddress}, 0(${labelAddress})`,
    `lw ${returnAddress}, 0(${returnStack})`,
    `addi ${returnStack}, ${returnStack}, 4`,
  ]
}


function compileLift(): string[] {
  return [
    `lw ${pairPointer}, 0(${sp})`,
    `lw ${left}, 0(${pairPointer})`,
    `lw ${right}, 4(${pairPointer})`,
    `lw ${cursor}, 4(${right})`,
    `addi ${roundedHigh}, ${left}, 2047`,
    `addi ${roundedHigh}, ${roundedHigh}, 1`,
    `srli ${roundedHigh}, ${roundedHigh}, 12`,
    `slli ${roundedHigh}, ${roundedHigh}, 12`,
    `ori ${instructionWord}, ${roundedHigh}, ${liftLuiBaseWord}`,
    `sw ${instructionWord}, 0(${cursor})`,
    `sub ${instructionWord}, ${left}, ${roundedHigh}`,
    `slli ${instructionWord}, ${instructionWord}, 20`,
    ...loadImmediate32(labelAddress, liftAddiBaseWord),
    `or ${instructionWord}, ${instructionWord}, ${labelAddress}`,
    `sw ${instructionWord}, 4(${cursor})`,
    ...storeInstructionWord(cursor, 8, rv32Word(`sw ${pairPointer}, 0(${sp})`)),
    ...storeInstructionWord(cursor, 12, rv32Word(returnFooter)),
    `addi ${pairPointer}, ${cursor}, 12`,
    `sw ${pairPointer}, 4(${right})`,
    `addi ${codeHeap}, ${cursor}, 16`,
  ]
}

function compileCall(context: CompileContext): string[] {
  const id = context.nextApplicationId
  context.nextApplicationId += 1
  const continuationLabel = `.Lccam_call_${id}_cont`

  return [
    `lw ${pairPointer}, 0(${sp})`,
    `lw ${labelAddress}, 0(${pairPointer})`,
    `addi ${returnStack}, ${returnStack}, -4`,
    `sw ${returnAddress}, 0(${returnStack})`,
    `jalr ${returnAddress}, 0(${labelAddress})`,
    `${continuationLabel}:`,
    `lw ${returnAddress}, 0(${returnStack})`,
    `addi ${returnStack}, ${returnStack}, 4`,
  ]
}

function compileApp(context: CompileContext): string[] {
  const id = context.nextApplicationId
  context.nextApplicationId += 1
  const continuationLabel = `.Lccam_app_${id}_cont`

  return [
    `lw ${pairPointer}, 0(${sp})`,
    `lw ${left}, 0(${pairPointer})`,
    `lw ${right}, 4(${pairPointer})`,
    `lw ${pairPointer}, 0(${left})`,
    `lw ${labelAddress}, 4(${left})`,
    `sw ${pairPointer}, 0(${heap})`,
    `sw ${right}, 4(${heap})`,
    `sw ${heap}, 0(${sp})`,
    `addi ${heap}, ${heap}, 8`,
    `addi ${returnStack}, ${returnStack}, -4`,
    `sw ${returnAddress}, 0(${returnStack})`,
    `jalr ${returnAddress}, 0(${labelAddress})`,
    `${continuationLabel}:`,
    `lw ${returnAddress}, 0(${returnStack})`,
    `addi ${returnStack}, ${returnStack}, 4`,
  ]
}

function compileCur(program: Instruction[], context: CompileContext): string[] {
  const id = context.nextClosureId
  context.nextClosureId += 1
  const bodyLabel = `.Lccam_cur_${id}_body`
  const addressLabel = `.Lccam_cur_${id}_addr`
  const body = [
    `${bodyLabel}:`,
    ...program.flatMap((instruction) => compileCommentedInstruction(instruction, context)),
    '; return',
    `jalr x0, 0(${returnAddress})`,
  ]
  context.closureBodies.push(body)

  return [
    `lw ${pairPointer}, 0(${sp})`,
    `sw ${pairPointer}, 0(${heap})`,
    `${addressLabel}:`,
    `auipc ${labelAddress}, %pcrel_hi(${bodyLabel})`,
    `addi ${labelAddress}, ${labelAddress}, %pcrel_lo(${addressLabel})`,
    `sw ${labelAddress}, 4(${heap})`,
    `sw ${heap}, 0(${sp})`,
    `addi ${heap}, ${heap}, 8`,
  ]
}

function compileQuote(value: Value): string[] {
  if (value.type === 'unit') return [`sw x0, 0(${heap})`, `sw ${heap}, 0(${sp})`, `addi ${heap}, ${heap}, 4`]
  const immediate = assertIntValue(value)
  assertRv32IImmediate(immediate)
  return [`addi ${pairPointer}, x0, ${immediate}`, `sw ${pairPointer}, 0(${heap})`, `sw ${heap}, 0(${sp})`, `addi ${heap}, ${heap}, 4`]
}

function compileGeneratedSnippet(addressRegister: string, lines: string[]): string[] {
  return lines.flatMap((line, index) => storeInstructionWord(addressRegister, index * 4, rv32Word(line)))
}

function storeInstructionWord(addressRegister: string, offset: number, word: number): string[] {
  return [...loadImmediate32(labelAddress, word), `sw ${labelAddress}, ${offset}(${addressRegister})`]
}

function loadImmediate32(register: string, value: number): string[] {
  const unsigned = value >>> 0
  const high = (unsigned + 0x800) & 0xfffff000
  const low = signExtend12(unsigned - high)
  if (high === 0) return [`addi ${register}, x0, ${low}`]
  if (low === 0) return [`lui ${register}, ${high}`]
  return [`lui ${register}, ${high}`, `addi ${register}, ${register}, ${low}`]
}

function rv32Word(line: string): number {
  return assembleRv32Line(line) >>> 0
}

function assertIntValue(value: Value): number {
  if (value.type !== 'int') throw new Error(`Unsupported CCAM quote value for RV32I compilation: ${value.type}`)
  return value.value
}

function assertRv32IImmediate(value: number): void {
  if (!Number.isInteger(value) || value < -2048 || value > 2047) {
    throw new Error(`CCAM integer quote out of RV32I addi immediate range: ${value}`)
  }
}

function signExtend12(value: number): number {
  const masked = value & 0xfff
  return masked & 0x800 ? masked - 0x1000 : masked
}

function assertUnsupportedInstruction(instruction: never): never {
  throw new Error(`Unsupported CCAM instruction for RV32I compilation: ${(instruction as { op: string }).op}`)
}
