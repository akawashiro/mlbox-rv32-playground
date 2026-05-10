export type Rv32TrapReason =
  | 'halt'
  | 'ecall'
  | 'ebreak'
  | 'illegal-instruction'
  | 'misaligned-fetch'
  | 'misaligned-load'
  | 'misaligned-store'
  | 'memory-out-of-bounds'

export type Rv32Trap = {
  reason: Rv32TrapReason
  message: string
  pc: number
}

export type Rv32State = {
  pc: number
  regs: Uint32Array
  memory: Uint8Array
  halted: boolean
  trap?: Rv32Trap
}

export type Rv32Snapshot = {
  pc: number
  regs: number[]
  halted: boolean
  trap?: Rv32Trap
}

export type Rv32DecodedInstruction = {
  word: number
  pc: number
  mnemonic: string
  operands: string
}

export type Rv32StepResult = {
  before: Rv32Snapshot
  after: Rv32Snapshot
  instruction: Rv32DecodedInstruction
  trap?: Rv32Trap
}

export type Rv32MachineOptions = {
  pc?: number
  regs?: ArrayLike<number>
  memorySize?: number
}

const defaultMemorySize = 64 * 1024
const initialMemoryWord = 0xdeadbeef
const registerCount = 32

export function createRv32Machine(program: Uint32Array | number[], options: Rv32MachineOptions = {}): Rv32State {
  const memory = new Uint8Array(options.memorySize ?? defaultMemorySize)
  fillUint32(memory, initialMemoryWord)
  if (program.length * 4 > memory.length) {
    throw new Error(`RV32I program requires ${program.length * 4} bytes, memory has ${memory.length}`)
  }

  for (let index = 0; index < program.length; index += 1) {
    writeUint32(memory, index * 4, program[index])
  }

  const regs = new Uint32Array(registerCount)
  if (options.regs) {
    for (let index = 0; index < Math.min(registerCount, options.regs.length); index += 1) {
      regs[index] = u32(options.regs[index])
    }
    regs[0] = 0
  }

  return { pc: u32(options.pc ?? 0), regs, memory, halted: false }
}

export function stepRv32(state: Rv32State): Rv32StepResult {
  const before = snapshotRv32(state)

  if (state.halted) {
    const trap = state.trap ?? makeTrap('halt', state.pc, 'RV32I machine is halted')
    return {
      before,
      after: snapshotRv32(state),
      instruction: { word: 0, pc: state.pc, mnemonic: 'halt', operands: '' },
      trap,
    }
  }

  const fetchTrap = fetchTrapFor(state, state.pc)
  if (fetchTrap) {
    return finishTrap(state, before, { word: 0, pc: state.pc, mnemonic: 'trap', operands: '' }, fetchTrap)
  }

  const pc = state.pc
  const word = readUint32(state.memory, pc)
  const decoded = decodeInstruction(word, pc)

  if (decoded.trap) return finishTrap(state, before, decoded.instruction, decoded.trap)

  const execTrap = executeDecoded(state, word, pc, decoded.instruction)
  state.regs[0] = 0

  if (execTrap) return finishTrap(state, before, decoded.instruction, execTrap)
  return { before, after: snapshotRv32(state), instruction: decoded.instruction }
}

export function runRv32(state: Rv32State, limit = 1000): Rv32StepResult[] {
  const steps: Rv32StepResult[] = []
  for (let step = 0; step < limit && !state.halted; step += 1) {
    steps.push(stepRv32(state))
  }
  return steps
}

export function snapshotRv32(state: Rv32State): Rv32Snapshot {
  return { pc: state.pc, regs: Array.from(state.regs), halted: state.halted, trap: state.trap }
}

export function formatRv32Register(index: number): string {
  return `x${index}`
}

export function formatRv32Word(value: number): string {
  return `0x${u32(value).toString(16).padStart(8, '0')}`
}

export function formatRv32Instruction(instruction: Rv32DecodedInstruction): string {
  return instruction.operands ? `${instruction.mnemonic} ${instruction.operands}` : instruction.mnemonic
}

export function formatRv32Snapshot(snapshot: Rv32Snapshot): string {
  const registers = snapshot.regs.map((value, index) => `${formatRv32Register(index)}=${formatRv32Word(value)}`)
  return `pc=${formatRv32Word(snapshot.pc)} ${registers.join(' ')}`
}

export function assembleRv32(source: string): Uint8Array {
  const parsed = parseRv32Assembly(source)
  const words = parsed.instructions.map((instruction) =>
    assembleRv32Line(resolveRv32Labels(instruction.source, instruction.pc, parsed)),
  )
  const bytes = new Uint8Array(words.length * 4)
  for (let index = 0; index < words.length; index += 1) {
    writeUint32(bytes, index * 4, words[index])
  }
  return bytes
}

type ParsedRv32Assembly = {
  instructions: ParsedRv32Instruction[]
  labels: Map<string, number>
}

type ParsedRv32Instruction = {
  source: string
  pc: number
}

const rv32LabelPattern = /^([A-Za-z_.$][A-Za-z0-9_.$]*):\s*/u
const rv32LabelReferencePattern = /^[A-Za-z_.$][A-Za-z0-9_.$]*$/u
const rv32BranchMnemonics = new Set(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'])

function parseRv32Assembly(source: string): ParsedRv32Assembly {
  const instructions: ParsedRv32Instruction[] = []
  const labels = new Map<string, number>()
  let pc = 0

  for (const rawLine of source.split(/\r?\n/)) {
    let line = stripRv32Comment(rawLine).trim()
    if (line.length === 0) continue

    while (true) {
      const match = rv32LabelPattern.exec(line)
      if (!match) break

      const label = match[1]
      if (labels.has(label)) throw new Error(`Duplicate RV32I label: ${label}`)
      labels.set(label, pc)
      line = line.slice(match[0].length).trim()
      if (line.length === 0) break
    }

    if (line.length === 0) continue
    instructions.push({ source: line, pc })
    pc += 4
  }

  return { instructions, labels }
}

function resolveRv32Labels(source: string, pc: number, parsed: ParsedRv32Assembly): string {
  const match = /^([a-z][a-z0-9]*)\b\s*(.*)$/u.exec(source)
  if (!match) return source

  const mnemonic = match[1]
  const operands = match[2].trim()
  const parts = operands.length === 0 ? [] : operands.split(',').map((part) => part.trim())

  if (mnemonic === 'jal' && parts.length === 2) {
    parts[1] = resolveRv32LabelOperand(parts[1], pc, parsed.labels)
    return `${mnemonic} ${parts.join(', ')}`
  }

  if (rv32BranchMnemonics.has(mnemonic) && parts.length === 3) {
    parts[2] = resolveRv32LabelOperand(parts[2], pc, parsed.labels)
    return `${mnemonic} ${parts.join(', ')}`
  }

  if (mnemonic === 'auipc' && parts.length === 2) {
    parts[1] = resolveRv32PcrelHiOperand(parts[1], pc, parsed)
    return `${mnemonic} ${parts.join(', ')}`
  }

  if (mnemonic === 'addi' && parts.length === 3) {
    parts[2] = resolveRv32PcrelLoOperand(parts[2], parsed)
    return `${mnemonic} ${parts.join(', ')}`
  }

  return source
}

function resolveRv32LabelOperand(operand: string, pc: number, labels: Map<string, number>): string {
  if (!rv32LabelReferencePattern.test(operand)) return operand
  const target = labels.get(operand)
  if (target === undefined) throw new Error(`Unknown RV32I label: ${operand}`)
  return String(target - pc)
}

function resolveRv32PcrelHiOperand(operand: string, pc: number, parsed: ParsedRv32Assembly): string {
  const label = parseRv32ModifierOperand(operand, 'pcrel_hi')
  if (label === null) return operand
  const target = parsed.labels.get(label)
  if (target === undefined) throw new Error(`Unknown RV32I label: ${label}`)
  return String(rv32PcrelHiImmediate(target - pc))
}

function resolveRv32PcrelLoOperand(operand: string, parsed: ParsedRv32Assembly): string {
  const auipcSiteLabel = parseRv32ModifierOperand(operand, 'pcrel_lo')
  if (auipcSiteLabel === null) return operand
  const auipcPc = parsed.labels.get(auipcSiteLabel)
  if (auipcPc === undefined) throw new Error(`Unknown RV32I label: ${auipcSiteLabel}`)

  const auipcInstruction = parsed.instructions.find((instruction) => instruction.pc === auipcPc)
  if (!auipcInstruction) throw new Error(`RV32I %pcrel_lo target is not an instruction label: ${auipcSiteLabel}`)

  const targetLabel = rv32PcrelHiTargetLabel(auipcInstruction.source)
  if (targetLabel === null) throw new Error(`RV32I %pcrel_lo target does not point to auipc %pcrel_hi: ${auipcSiteLabel}`)

  const target = parsed.labels.get(targetLabel)
  if (target === undefined) throw new Error(`Unknown RV32I label: ${targetLabel}`)
  return String(rv32PcrelLoImmediate(target - auipcPc))
}

function rv32PcrelHiTargetLabel(source: string): string | null {
  const match = /^auipc\b\s+[^,]+,\s*(%pcrel_hi\([^)]+\))\s*$/u.exec(source)
  if (!match) return null
  return parseRv32ModifierOperand(match[1], 'pcrel_hi')
}

function parseRv32ModifierOperand(operand: string, modifier: 'pcrel_hi' | 'pcrel_lo'): string | null {
  const match = new RegExp(`^%${modifier}\\(([A-Za-z_.$][A-Za-z0-9_.$]*)\\)$`, 'u').exec(operand)
  return match ? match[1] : null
}

function rv32PcrelHiImmediate(offset: number): number {
  return (offset + 0x800) & 0xfffff000
}

function rv32PcrelLoImmediate(offset: number): number {
  return signExtend(offset - rv32PcrelHiImmediate(offset), 12)
}

function stripRv32Comment(line: string): string {
  const hash = line.indexOf('#')
  const semicolon = line.indexOf(';')
  const indexes = [hash, semicolon].filter((index) => index >= 0)
  return indexes.length === 0 ? line : line.slice(0, Math.min(...indexes))
}

export function disassembleRv32(bytes: Uint8Array): string {
  if (bytes.length % 4 !== 0) throw new Error(`RV32I byte length must be a multiple of 4, got ${bytes.length}`)

  const lines: string[] = []
  for (let address = 0; address < bytes.length; address += 4) {
    lines.push(disassembleRv32Word(readUint32(bytes, address), address))
  }
  return lines.join('\n')
}

export function assembleRv32Line(line: string): number {
  const source = line.trim()
  if (source.length === 0) throw new Error('RV32I instruction line is empty')
  if (source.includes(':')) throw new Error(`RV32I labels are not supported: ${source}`)

  const match = /^([a-z][a-z0-9]*)\b\s*(.*)$/u.exec(source)
  if (!match) throw new Error(`Invalid RV32I instruction: ${source}`)

  const mnemonic = match[1]
  const operands = match[2].trim()
  const parts = operands.length === 0 ? [] : operands.split(',').map((part) => part.trim())

  switch (mnemonic) {
    case 'lui':
      return encodeU(expectRegister(parts, 0, mnemonic), expectImmediate(parts, 1, mnemonic), 0x37, mnemonic, parts, 'u')
    case 'auipc':
      return encodeU(expectRegister(parts, 0, mnemonic), expectImmediate(parts, 1, mnemonic), 0x17, mnemonic, parts, 'u')
    case 'jal':
      return encodeJ(expectRegister(parts, 0, mnemonic), expectImmediate(parts, 1, mnemonic), mnemonic, parts)
    case 'jalr': {
      expectOperandCount(parts, mnemonic, 2)
      const address = expectAddress(parts, 1, mnemonic)
      return encodeI(expectRegister(parts, 0, mnemonic), address.register, address.offset, 0, 0x67, mnemonic)
    }
    case 'lb':
      return encodeLoad(parts, mnemonic, 0)
    case 'lh':
      return encodeLoad(parts, mnemonic, 1)
    case 'lw':
      return encodeLoad(parts, mnemonic, 2)
    case 'lbu':
      return encodeLoad(parts, mnemonic, 4)
    case 'lhu':
      return encodeLoad(parts, mnemonic, 5)
    case 'sb':
      return encodeStore(parts, mnemonic, 0)
    case 'sh':
      return encodeStore(parts, mnemonic, 1)
    case 'sw':
      return encodeStore(parts, mnemonic, 2)
    case 'beq':
      return encodeBranch(parts, mnemonic, 0)
    case 'bne':
      return encodeBranch(parts, mnemonic, 1)
    case 'blt':
      return encodeBranch(parts, mnemonic, 4)
    case 'bge':
      return encodeBranch(parts, mnemonic, 5)
    case 'bltu':
      return encodeBranch(parts, mnemonic, 6)
    case 'bgeu':
      return encodeBranch(parts, mnemonic, 7)
    case 'addi':
      return encodeOpImmediate(parts, mnemonic, 0)
    case 'slti':
      return encodeOpImmediate(parts, mnemonic, 2)
    case 'sltiu':
      return encodeOpImmediate(parts, mnemonic, 3)
    case 'xori':
      return encodeOpImmediate(parts, mnemonic, 4)
    case 'ori':
      return encodeOpImmediate(parts, mnemonic, 6)
    case 'andi':
      return encodeOpImmediate(parts, mnemonic, 7)
    case 'slli':
      return encodeShiftImmediate(parts, mnemonic, 1, 0)
    case 'srli':
      return encodeShiftImmediate(parts, mnemonic, 5, 0)
    case 'srai':
      return encodeShiftImmediate(parts, mnemonic, 5, 0x20)
    case 'add':
      return encodeRegisterOp(parts, mnemonic, 0, 0)
    case 'sub':
      return encodeRegisterOp(parts, mnemonic, 0, 0x20)
    case 'sll':
      return encodeRegisterOp(parts, mnemonic, 1, 0)
    case 'slt':
      return encodeRegisterOp(parts, mnemonic, 2, 0)
    case 'sltu':
      return encodeRegisterOp(parts, mnemonic, 3, 0)
    case 'xor':
      return encodeRegisterOp(parts, mnemonic, 4, 0)
    case 'srl':
      return encodeRegisterOp(parts, mnemonic, 5, 0)
    case 'sra':
      return encodeRegisterOp(parts, mnemonic, 5, 0x20)
    case 'or':
      return encodeRegisterOp(parts, mnemonic, 6, 0)
    case 'and':
      return encodeRegisterOp(parts, mnemonic, 7, 0)
    case 'fence':
      expectOperandCount(parts, mnemonic, 0)
      return 0x0000000f
    case 'ecall':
      expectOperandCount(parts, mnemonic, 0)
      return 0x00000073
    case 'ebreak':
      expectOperandCount(parts, mnemonic, 0)
      return 0x00100073
    default:
      throw new Error(`Unknown RV32I mnemonic: ${mnemonic}`)
  }
}

export function disassembleRv32Word(word: number, pc = 0): string {
  const opcode = bits(word, 0, 7)
  const rd = bits(word, 7, 5)
  const funct3 = bits(word, 12, 3)
  const rs1 = bits(word, 15, 5)
  const rs2 = bits(word, 20, 5)
  const funct7 = bits(word, 25, 7)

  switch (opcode) {
    case 0x37:
      return `lui ${reg(rd)}, ${s32(immU(word))}`
    case 0x17:
      return `auipc ${reg(rd)}, ${s32(immU(word))}`
    case 0x6f:
      return `jal ${reg(rd)}, ${immJ(word)}`
    case 0x67:
      if (funct3 === 0) return `jalr ${reg(rd)}, ${immI(word)}(${reg(rs1)})`
      break
    case 0x63: {
      const names = ['beq', 'bne', '', '', 'blt', 'bge', 'bltu', 'bgeu']
      const mnemonic = names[funct3]
      if (mnemonic) return `${mnemonic} ${reg(rs1)}, ${reg(rs2)}, ${immB(word)}`
      break
    }
    case 0x03: {
      const names = ['lb', 'lh', 'lw', '', 'lbu', 'lhu']
      const mnemonic = names[funct3]
      if (mnemonic) return `${mnemonic} ${reg(rd)}, ${immI(word)}(${reg(rs1)})`
      break
    }
    case 0x23: {
      const names = ['sb', 'sh', 'sw']
      const mnemonic = names[funct3]
      if (mnemonic) return `${mnemonic} ${reg(rs2)}, ${immS(word)}(${reg(rs1)})`
      break
    }
    case 0x13:
      return disassembleOpImmediate(word, rd, rs1, funct3, funct7)
    case 0x33:
      return disassembleRegisterOp(word, rd, rs1, rs2, funct3, funct7)
    case 0x0f:
      if (funct3 === 0) return 'fence'
      break
    case 0x73:
      if (word === 0x00000073) return 'ecall'
      if (word === 0x00100073) return 'ebreak'
      break
  }

  throw new Error(`Illegal RV32I instruction at ${formatRv32Word(pc)}: ${formatRv32Word(word)}`)
}

function encodeLoad(parts: string[], mnemonic: string, funct3: number): number {
  expectOperandCount(parts, mnemonic, 2)
  const address = expectAddress(parts, 1, mnemonic)
  return encodeI(expectRegister(parts, 0, mnemonic), address.register, address.offset, funct3, 0x03, mnemonic)
}

function encodeStore(parts: string[], mnemonic: string, funct3: number): number {
  const address = expectAddress(parts, 1, mnemonic)
  return encodeS(address.offset, expectRegister(parts, 0, mnemonic), address.register, funct3, mnemonic, parts)
}

function encodeBranch(parts: string[], mnemonic: string, funct3: number): number {
  const offset = expectImmediate(parts, 2, mnemonic)
  expectOperandCount(parts, mnemonic, 3)
  expectSignedRange(offset, 13, mnemonic)
  if (offset % 2 !== 0) throw new Error(`${mnemonic} offset must be 2-byte aligned: ${offset}`)
  const rs1 = expectRegister(parts, 0, mnemonic)
  const rs2 = expectRegister(parts, 1, mnemonic)
  const imm = offset & 0x1fff
  return u32(
    (((imm >>> 12) & 1) << 31) |
      (((imm >>> 5) & 0x3f) << 25) |
      (rs2 << 20) |
      (rs1 << 15) |
      (funct3 << 12) |
      (((imm >>> 1) & 0xf) << 8) |
      (((imm >>> 11) & 1) << 7) |
      0x63,
  )
}

function encodeOpImmediate(parts: string[], mnemonic: string, funct3: number): number {
  expectOperandCount(parts, mnemonic, 3)
  return encodeI(
    expectRegister(parts, 0, mnemonic),
    expectRegister(parts, 1, mnemonic),
    expectImmediate(parts, 2, mnemonic),
    funct3,
    0x13,
    mnemonic,
  )
}

function encodeShiftImmediate(
  parts: string[],
  mnemonic: string,
  funct3: number,
  funct7: number,
): number {
  const shamt = expectImmediate(parts, 2, mnemonic)
  expectOperandCount(parts, mnemonic, 3)
  if (shamt < 0 || shamt > 31) throw new Error(`${mnemonic} shift amount out of range: ${shamt}`)
  return u32((funct7 << 25) | (shamt << 20) | (expectRegister(parts, 1, mnemonic) << 15) | (funct3 << 12) | (expectRegister(parts, 0, mnemonic) << 7) | 0x13)
}

function encodeRegisterOp(parts: string[], mnemonic: string, funct3: number, funct7: number): number {
  expectOperandCount(parts, mnemonic, 3)
  return u32(
    (funct7 << 25) |
      (expectRegister(parts, 2, mnemonic) << 20) |
      (expectRegister(parts, 1, mnemonic) << 15) |
      (funct3 << 12) |
      (expectRegister(parts, 0, mnemonic) << 7) |
      0x33,
  )
}

function encodeI(
  rd: number,
  rs1: number,
  immediate: number,
  funct3: number,
  opcode: number,
  mnemonic: string,
): number {
  expectSignedRange(immediate, 12, mnemonic)
  return u32(((immediate & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode)
}

function encodeS(
  immediate: number,
  rs2: number,
  rs1: number,
  funct3: number,
  mnemonic: string,
  parts: string[],
): number {
  expectOperandCount(parts, mnemonic, 2)
  expectSignedRange(immediate, 12, mnemonic)
  const imm = immediate & 0xfff
  return u32(((imm >>> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | ((imm & 0x1f) << 7) | 0x23)
}

function encodeU(
  rd: number,
  immediate: number,
  opcode: number,
  mnemonic: string,
  parts: string[],
  rangeName: 'u',
): number {
  expectOperandCount(parts, mnemonic, 2)
  if (rangeName === 'u' && immediate % 4096 !== 0) {
    throw new Error(`${mnemonic} immediate must be 4096-byte aligned: ${immediate}`)
  }
  if (immediate < -2147483648 || immediate > 0xfffff000) throw new Error(`${mnemonic} immediate out of range: ${immediate}`)
  return u32((immediate & 0xfffff000) | (rd << 7) | opcode)
}

function encodeJ(rd: number, immediate: number, mnemonic: string, parts: string[]): number {
  expectOperandCount(parts, mnemonic, 2)
  expectSignedRange(immediate, 21, mnemonic)
  if (immediate % 2 !== 0) throw new Error(`${mnemonic} offset must be 2-byte aligned: ${immediate}`)
  const imm = immediate & 0x1fffff
  return u32(
    (((imm >>> 20) & 1) << 31) |
      (((imm >>> 1) & 0x3ff) << 21) |
      (((imm >>> 11) & 1) << 20) |
      (((imm >>> 12) & 0xff) << 12) |
      (rd << 7) |
      0x6f,
  )
}

function disassembleOpImmediate(word: number, rd: number, rs1: number, funct3: number, funct7: number): string {
  const shamt = bits(word, 20, 5)
  switch (funct3) {
    case 0:
      return `addi ${reg(rd)}, ${reg(rs1)}, ${immI(word)}`
    case 1:
      if (funct7 === 0) return `slli ${reg(rd)}, ${reg(rs1)}, ${shamt}`
      break
    case 2:
      return `slti ${reg(rd)}, ${reg(rs1)}, ${immI(word)}`
    case 3:
      return `sltiu ${reg(rd)}, ${reg(rs1)}, ${immI(word)}`
    case 4:
      return `xori ${reg(rd)}, ${reg(rs1)}, ${immI(word)}`
    case 5:
      if (funct7 === 0) return `srli ${reg(rd)}, ${reg(rs1)}, ${shamt}`
      if (funct7 === 0x20) return `srai ${reg(rd)}, ${reg(rs1)}, ${shamt}`
      break
    case 6:
      return `ori ${reg(rd)}, ${reg(rs1)}, ${immI(word)}`
    case 7:
      return `andi ${reg(rd)}, ${reg(rs1)}, ${immI(word)}`
  }
  throw new Error(`Illegal RV32I instruction: ${formatRv32Word(word)}`)
}

function disassembleRegisterOp(
  word: number,
  rd: number,
  rs1: number,
  rs2: number,
  funct3: number,
  funct7: number,
): string {
  const ops: Record<string, string> = {
    '0:0': 'add',
    '32:0': 'sub',
    '0:1': 'sll',
    '0:2': 'slt',
    '0:3': 'sltu',
    '0:4': 'xor',
    '0:5': 'srl',
    '32:5': 'sra',
    '0:6': 'or',
    '0:7': 'and',
  }
  const mnemonic = ops[`${funct7}:${funct3}`]
  if (!mnemonic) throw new Error(`Illegal RV32I instruction: ${formatRv32Word(word)}`)
  return `${mnemonic} ${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`
}

function expectRegister(parts: string[], index: number, mnemonic: string): number {
  const value = parts[index]
  if (value === undefined) throw new Error(`${mnemonic} is missing operand ${index + 1}`)
  const match = /^x([0-9]|[12][0-9]|3[01])$/u.exec(value)
  if (!match) throw new Error(`Invalid RV32I register for ${mnemonic}: ${value}`)
  return Number(match[1])
}

function expectImmediate(parts: string[], index: number, mnemonic: string): number {
  const value = parts[index]
  if (value === undefined) throw new Error(`${mnemonic} is missing operand ${index + 1}`)
  if (!/^-?(?:0x[0-9a-f]+|[0-9]+)$/iu.test(value)) throw new Error(`Invalid RV32I immediate for ${mnemonic}: ${value}`)
  const sign = value.startsWith('-') ? -1 : 1
  const unsigned = value.startsWith('-') ? value.slice(1) : value
  return sign * Number.parseInt(unsigned, unsigned.toLowerCase().startsWith('0x') ? 16 : 10)
}

function expectAddress(parts: string[], index: number, mnemonic: string): { offset: number; register: number } {
  const value = parts[index]
  if (value === undefined) throw new Error(`${mnemonic} is missing operand ${index + 1}`)
  const match = /^(-?(?:0x[0-9a-f]+|[0-9]+))\((x(?:[0-9]|[12][0-9]|3[01]))\)$/iu.exec(value)
  if (!match) throw new Error(`Invalid RV32I address operand for ${mnemonic}: ${value}`)
  return {
    offset: expectImmediate([match[1]], 0, mnemonic),
    register: expectRegister([match[2]], 0, mnemonic),
  }
}

function expectOperandCount(parts: string[], mnemonic: string, expected: number): void {
  if (parts.length !== expected) throw new Error(`${mnemonic} expects ${expected} operands, got ${parts.length}`)
}

function expectSignedRange(value: number, bitsLength: number, mnemonic: string): void {
  const minimum = -(2 ** (bitsLength - 1))
  const maximum = 2 ** (bitsLength - 1) - 1
  if (value < minimum || value > maximum) throw new Error(`${mnemonic} immediate out of range: ${value}`)
}

type DecodeResult = {
  instruction: Rv32DecodedInstruction
  trap?: Rv32Trap
}

function decodeInstruction(word: number, pc: number): DecodeResult {
  const opcode = bits(word, 0, 7)
  const rd = bits(word, 7, 5)
  const funct3 = bits(word, 12, 3)
  const rs1 = bits(word, 15, 5)
  const rs2 = bits(word, 20, 5)
  const funct7 = bits(word, 25, 7)

  switch (opcode) {
    case 0x37:
      return decoded(word, pc, 'lui', `${reg(rd)}, ${formatImmediate(immU(word))}`)
    case 0x17:
      return decoded(word, pc, 'auipc', `${reg(rd)}, ${formatImmediate(immU(word))}`)
    case 0x6f:
      return decoded(word, pc, 'jal', `${reg(rd)}, ${formatImmediate(immJ(word))}`)
    case 0x67:
      if (funct3 === 0) return decoded(word, pc, 'jalr', `${reg(rd)}, ${immI(word)}(${reg(rs1)})`)
      return illegal(word, pc)
    case 0x63:
      return decodeBranch(word, pc, funct3, rs1, rs2)
    case 0x03:
      return decodeLoad(word, pc, funct3, rd, rs1)
    case 0x23:
      return decodeStore(word, pc, funct3, rs1, rs2)
    case 0x13:
      return decodeOpImm(word, pc, funct3, funct7, rd, rs1)
    case 0x33:
      return decodeOp(word, pc, funct3, funct7, rd, rs1, rs2)
    case 0x0f:
      if (funct3 === 0) return decoded(word, pc, 'fence', '')
      return illegal(word, pc)
    case 0x73:
      if (word === 0x00000073) return decoded(word, pc, 'ecall', '')
      if (word === 0x00100073) return decoded(word, pc, 'ebreak', '')
      return illegal(word, pc)
    default:
      return illegal(word, pc)
  }
}

function decodeBranch(word: number, pc: number, funct3: number, rs1: number, rs2: number): DecodeResult {
  const names = ['beq', 'bne', '', '', 'blt', 'bge', 'bltu', 'bgeu']
  const mnemonic = names[funct3]
  if (!mnemonic) return illegal(word, pc)
  return decoded(word, pc, mnemonic, `${reg(rs1)}, ${reg(rs2)}, ${formatImmediate(immB(word))}`)
}

function decodeLoad(word: number, pc: number, funct3: number, rd: number, rs1: number): DecodeResult {
  const names = ['lb', 'lh', 'lw', '', 'lbu', 'lhu']
  const mnemonic = names[funct3]
  if (!mnemonic) return illegal(word, pc)
  return decoded(word, pc, mnemonic, `${reg(rd)}, ${immI(word)}(${reg(rs1)})`)
}

function decodeStore(word: number, pc: number, funct3: number, rs1: number, rs2: number): DecodeResult {
  const names = ['sb', 'sh', 'sw']
  const mnemonic = names[funct3]
  if (!mnemonic) return illegal(word, pc)
  return decoded(word, pc, mnemonic, `${reg(rs2)}, ${immS(word)}(${reg(rs1)})`)
}

function decodeOpImm(word: number, pc: number, funct3: number, funct7: number, rd: number, rs1: number): DecodeResult {
  const shamt = bits(word, 20, 5)
  switch (funct3) {
    case 0:
      return decoded(word, pc, 'addi', `${reg(rd)}, ${reg(rs1)}, ${formatImmediate(immI(word))}`)
    case 2:
      return decoded(word, pc, 'slti', `${reg(rd)}, ${reg(rs1)}, ${formatImmediate(immI(word))}`)
    case 3:
      return decoded(word, pc, 'sltiu', `${reg(rd)}, ${reg(rs1)}, ${formatImmediate(immI(word))}`)
    case 4:
      return decoded(word, pc, 'xori', `${reg(rd)}, ${reg(rs1)}, ${formatImmediate(immI(word))}`)
    case 6:
      return decoded(word, pc, 'ori', `${reg(rd)}, ${reg(rs1)}, ${formatImmediate(immI(word))}`)
    case 7:
      return decoded(word, pc, 'andi', `${reg(rd)}, ${reg(rs1)}, ${formatImmediate(immI(word))}`)
    case 1:
      if (funct7 === 0) return decoded(word, pc, 'slli', `${reg(rd)}, ${reg(rs1)}, ${shamt}`)
      return illegal(word, pc)
    case 5:
      if (funct7 === 0) return decoded(word, pc, 'srli', `${reg(rd)}, ${reg(rs1)}, ${shamt}`)
      if (funct7 === 0x20) return decoded(word, pc, 'srai', `${reg(rd)}, ${reg(rs1)}, ${shamt}`)
      return illegal(word, pc)
    default:
      return illegal(word, pc)
  }
}

function decodeOp(
  word: number,
  pc: number,
  funct3: number,
  funct7: number,
  rd: number,
  rs1: number,
  rs2: number,
): DecodeResult {
  const ops: Record<string, string> = {
    '0:0': 'add',
    '32:0': 'sub',
    '0:1': 'sll',
    '0:2': 'slt',
    '0:3': 'sltu',
    '0:4': 'xor',
    '0:5': 'srl',
    '32:5': 'sra',
    '0:6': 'or',
    '0:7': 'and',
  }
  const mnemonic = ops[`${funct7}:${funct3}`]
  if (!mnemonic) return illegal(word, pc)
  return decoded(word, pc, mnemonic, `${reg(rd)}, ${reg(rs1)}, ${reg(rs2)}`)
}

function executeDecoded(
  state: Rv32State,
  word: number,
  pc: number,
  instruction: Rv32DecodedInstruction,
): Rv32Trap | undefined {
  const opcode = bits(word, 0, 7)
  const rd = bits(word, 7, 5)
  const funct3 = bits(word, 12, 3)
  const rs1 = bits(word, 15, 5)
  const rs2 = bits(word, 20, 5)
  const funct7 = bits(word, 25, 7)
  const nextPc = u32(pc + 4)

  switch (opcode) {
    case 0x37:
      state.regs[rd] = u32(immU(word))
      state.pc = nextPc
      return
    case 0x17:
      state.regs[rd] = u32(pc + immU(word))
      state.pc = nextPc
      return
    case 0x6f:
      state.regs[rd] = nextPc
      state.pc = u32(pc + immJ(word))
      return
    case 0x67:
      state.regs[rd] = nextPc
      state.pc = u32((state.regs[rs1] + immI(word)) & ~1)
      return
    case 0x63:
      state.pc = branchTaken(state.regs[rs1], state.regs[rs2], funct3) ? u32(pc + immB(word)) : nextPc
      return
    case 0x03:
      return executeLoad(state, pc, rd, rs1, funct3, immI(word), nextPc)
    case 0x23:
      return executeStore(state, pc, rs1, rs2, funct3, immS(word), nextPc)
    case 0x13:
      state.regs[rd] = executeOpImmValue(state.regs[rs1], immI(word), bits(word, 20, 5), funct3, funct7)
      state.pc = nextPc
      return
    case 0x33:
      state.regs[rd] = executeOpValue(state.regs[rs1], state.regs[rs2], funct3, funct7)
      state.pc = nextPc
      return
    case 0x0f:
      state.pc = nextPc
      return
    case 0x73:
      if (instruction.mnemonic === 'ecall') return makeTrap('ecall', pc, 'ECALL')
      if (instruction.mnemonic === 'ebreak') return makeTrap('ebreak', pc, 'EBREAK')
      return makeTrap('illegal-instruction', pc, `Illegal instruction ${formatRv32Word(word)}`)
    default:
      return makeTrap('illegal-instruction', pc, `Illegal instruction ${formatRv32Word(word)}`)
  }
}

function executeLoad(
  state: Rv32State,
  pc: number,
  rd: number,
  rs1: number,
  funct3: number,
  offset: number,
  nextPc: number,
): Rv32Trap | undefined {
  const address = u32(state.regs[rs1] + offset)
  const size = funct3 === 0 || funct3 === 4 ? 1 : funct3 === 1 || funct3 === 5 ? 2 : 4
  const trap = memoryTrapFor(state, pc, address, size, 'load')
  if (trap) return trap

  if (funct3 === 0) state.regs[rd] = u32(signExtend(readUint8(state.memory, address), 8))
  if (funct3 === 1) state.regs[rd] = u32(signExtend(readUint16(state.memory, address), 16))
  if (funct3 === 2) state.regs[rd] = readUint32(state.memory, address)
  if (funct3 === 4) state.regs[rd] = readUint8(state.memory, address)
  if (funct3 === 5) state.regs[rd] = readUint16(state.memory, address)
  state.pc = nextPc
  return
}

function executeStore(
  state: Rv32State,
  pc: number,
  rs1: number,
  rs2: number,
  funct3: number,
  offset: number,
  nextPc: number,
): Rv32Trap | undefined {
  const address = u32(state.regs[rs1] + offset)
  const size = funct3 === 0 ? 1 : funct3 === 1 ? 2 : 4
  const trap = memoryTrapFor(state, pc, address, size, 'store')
  if (trap) return trap

  if (funct3 === 0) writeUint8(state.memory, address, state.regs[rs2])
  if (funct3 === 1) writeUint16(state.memory, address, state.regs[rs2])
  if (funct3 === 2) writeUint32(state.memory, address, state.regs[rs2])
  state.pc = nextPc
  return
}

function executeOpImmValue(rs1: number, immediate: number, shamt: number, funct3: number, funct7: number): number {
  switch (funct3) {
    case 0:
      return u32(rs1 + immediate)
    case 1:
      return u32(rs1 << shamt)
    case 2:
      return s32(rs1) < immediate ? 1 : 0
    case 3:
      return rs1 >>> 0 < u32(immediate) ? 1 : 0
    case 4:
      return u32(rs1 ^ immediate)
    case 5:
      return funct7 === 0x20 ? u32(s32(rs1) >> shamt) : rs1 >>> shamt
    case 6:
      return u32(rs1 | immediate)
    case 7:
      return u32(rs1 & immediate)
    default:
      return 0
  }
}

function executeOpValue(rs1: number, rs2: number, funct3: number, funct7: number): number {
  const shamt = rs2 & 0x1f
  switch (`${funct7}:${funct3}`) {
    case '0:0':
      return u32(rs1 + rs2)
    case '32:0':
      return u32(rs1 - rs2)
    case '0:1':
      return u32(rs1 << shamt)
    case '0:2':
      return s32(rs1) < s32(rs2) ? 1 : 0
    case '0:3':
      return rs1 >>> 0 < rs2 >>> 0 ? 1 : 0
    case '0:4':
      return u32(rs1 ^ rs2)
    case '0:5':
      return rs1 >>> shamt
    case '32:5':
      return u32(s32(rs1) >> shamt)
    case '0:6':
      return u32(rs1 | rs2)
    case '0:7':
      return u32(rs1 & rs2)
    default:
      return 0
  }
}

function branchTaken(left: number, right: number, funct3: number): boolean {
  switch (funct3) {
    case 0:
      return left === right
    case 1:
      return left !== right
    case 4:
      return s32(left) < s32(right)
    case 5:
      return s32(left) >= s32(right)
    case 6:
      return left >>> 0 < right >>> 0
    case 7:
      return left >>> 0 >= right >>> 0
    default:
      return false
  }
}

function finishTrap(
  state: Rv32State,
  before: Rv32Snapshot,
  instruction: Rv32DecodedInstruction,
  trap: Rv32Trap,
): Rv32StepResult {
  state.halted = true
  state.trap = trap
  state.regs[0] = 0
  return { before, after: snapshotRv32(state), instruction, trap }
}

function fetchTrapFor(state: Rv32State, pc: number): Rv32Trap | undefined {
  if (pc % 4 !== 0) return makeTrap('misaligned-fetch', pc, `Misaligned instruction fetch at ${formatRv32Word(pc)}`)
  if (!isInBounds(state.memory, pc, 4)) {
    return makeTrap('memory-out-of-bounds', pc, `Instruction fetch outside memory at ${formatRv32Word(pc)}`)
  }
  return
}

function memoryTrapFor(
  state: Rv32State,
  pc: number,
  address: number,
  size: number,
  kind: 'load' | 'store',
): Rv32Trap | undefined {
  if (address % size !== 0) {
    const reason = kind === 'load' ? 'misaligned-load' : 'misaligned-store'
    return makeTrap(reason, pc, `Misaligned ${kind} at ${formatRv32Word(address)}`)
  }
  if (!isInBounds(state.memory, address, size)) {
    return makeTrap('memory-out-of-bounds', pc, `${kind} outside memory at ${formatRv32Word(address)}`)
  }
  return
}

function makeTrap(reason: Rv32TrapReason, pc: number, message: string): Rv32Trap {
  return { reason, pc, message }
}

function decoded(word: number, pc: number, mnemonic: string, operands: string): DecodeResult {
  return { instruction: { word: u32(word), pc, mnemonic, operands } }
}

function illegal(word: number, pc: number): DecodeResult {
  return {
    instruction: { word: u32(word), pc, mnemonic: 'illegal', operands: formatRv32Word(word) },
    trap: makeTrap('illegal-instruction', pc, `Illegal instruction ${formatRv32Word(word)}`),
  }
}

function bits(value: number, offset: number, length: number): number {
  return (value >>> offset) & ((1 << length) - 1)
}

function immI(word: number): number {
  return signExtend(bits(word, 20, 12), 12)
}

function immS(word: number): number {
  return signExtend((bits(word, 25, 7) << 5) | bits(word, 7, 5), 12)
}

function immB(word: number): number {
  return signExtend((bits(word, 31, 1) << 12) | (bits(word, 7, 1) << 11) | (bits(word, 25, 6) << 5) | (bits(word, 8, 4) << 1), 13)
}

function immU(word: number): number {
  return u32(word & 0xfffff000)
}

function immJ(word: number): number {
  return signExtend(
    (bits(word, 31, 1) << 20) | (bits(word, 12, 8) << 12) | (bits(word, 20, 1) << 11) | (bits(word, 21, 10) << 1),
    21,
  )
}

function signExtend(value: number, bitsLength: number): number {
  const shift = 32 - bitsLength
  return (value << shift) >> shift
}

function u32(value: number): number {
  return value >>> 0
}

function s32(value: number): number {
  return value | 0
}

function reg(index: number): string {
  return `x${index}`
}

function formatImmediate(value: number): string {
  return value < 0 ? String(value) : formatRv32Word(value)
}

function isInBounds(memory: Uint8Array, address: number, size: number): boolean {
  return address <= memory.length - size
}

function readUint8(memory: Uint8Array, address: number): number {
  return memory[address]
}

function readUint16(memory: Uint8Array, address: number): number {
  return memory[address] | (memory[address + 1] << 8)
}

function readUint32(memory: Uint8Array, address: number): number {
  return u32(memory[address] | (memory[address + 1] << 8) | (memory[address + 2] << 16) | (memory[address + 3] << 24))
}

function writeUint8(memory: Uint8Array, address: number, value: number): void {
  memory[address] = value & 0xff
}

function writeUint16(memory: Uint8Array, address: number, value: number): void {
  memory[address] = value & 0xff
  memory[address + 1] = (value >>> 8) & 0xff
}

function writeUint32(memory: Uint8Array, address: number, value: number): void {
  memory[address] = value & 0xff
  memory[address + 1] = (value >>> 8) & 0xff
  memory[address + 2] = (value >>> 16) & 0xff
  memory[address + 3] = (value >>> 24) & 0xff
}

function fillUint32(memory: Uint8Array, value: number): void {
  for (let address = 0; address <= memory.length - 4; address += 4) {
    writeUint32(memory, address, value)
  }
}
