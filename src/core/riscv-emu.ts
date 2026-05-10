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
