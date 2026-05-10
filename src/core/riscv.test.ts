import { describe, expect, it } from 'vitest'
import {
  assembleRv32,
} from './riscv-asm'
import {
  createRv32Machine,
  formatRv32Instruction,
  formatRv32Word,
  runRv32,
  stepRv32,
} from './riscv-emu'

function r(funct7: number, rs2: number, rs1: number, funct3: number, rd: number, opcode = 0x33): number {
  return (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode
}

function i(immediate: number, rs1: number, funct3: number, rd: number, opcode = 0x13): number {
  return ((immediate & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode
}

function s(immediate: number, rs2: number, rs1: number, funct3: number): number {
  const imm = immediate & 0xfff
  return ((imm >>> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | ((imm & 0x1f) << 7) | 0x23
}

function b(immediate: number, rs2: number, rs1: number, funct3: number): number {
  const imm = immediate & 0x1fff
  return (
    (((imm >>> 12) & 1) << 31) |
    (((imm >>> 5) & 0x3f) << 25) |
    (rs2 << 20) |
    (rs1 << 15) |
    (funct3 << 12) |
    (((imm >>> 1) & 0xf) << 8) |
    (((imm >>> 11) & 1) << 7) |
    0x63
  )
}

function u(immediate: number, rd: number, opcode: number): number {
  return (immediate & 0xfffff000) | (rd << 7) | opcode
}

function j(immediate: number, rd: number): number {
  const imm = immediate & 0x1fffff
  return (
    (((imm >>> 20) & 1) << 31) |
    (((imm >>> 1) & 0x3ff) << 21) |
    (((imm >>> 11) & 1) << 20) |
    (((imm >>> 12) & 0xff) << 12) |
    (rd << 7) |
    0x6f
  )
}

const ecall = 0x00000073
const ebreak = 0x00100073

function wordsFromBytes(bytes: Uint8Array): number[] {
  const words: number[] = []
  for (let index = 0; index < bytes.length; index += 4) {
    words.push((bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24)) >>> 0)
  }
  return words
}

function runAssembly(source: string, limit = 1000) {
  const state = createRv32Machine(wordsFromBytes(assembleRv32(source)))
  const steps = runRv32(state, limit)
  return { state, steps }
}

function readUint32(bytes: Uint8Array, address: number): number {
  return (bytes[address] | (bytes[address + 1] << 8) | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0
}

describe('RV32I emulator', () => {
  it('initializes memory with 0xdeadbeef words before loading the program', () => {
    const state = createRv32Machine([ecall], { memorySize: 16 })

    expect(readUint32(state.memory, 0)).toBe(ecall)
    expect(readUint32(state.memory, 4)).toBe(0xdeadbeef)
    expect(readUint32(state.memory, 8)).toBe(0xdeadbeef)
    expect(readUint32(state.memory, 12)).toBe(0xdeadbeef)
    expect(Array.from(state.memory.slice(4, 8))).toEqual([0xef, 0xbe, 0xad, 0xde])
  })

  it('executes one instruction at a time and reports snapshots', () => {
    const state = createRv32Machine([i(41, 0, 0, 1), i(1, 1, 0, 2)])

    const first = stepRv32(state)
    expect(formatRv32Instruction(first.instruction)).toBe('addi x1, x0, 0x00000029')
    expect(first.before.pc).toBe(0)
    expect(first.after.pc).toBe(4)
    expect(first.after.regs[1]).toBe(41)

    const second = stepRv32(state)
    expect(second.after.regs[2]).toBe(42)
    expect(state.pc).toBe(8)
  })

  it('runs integer register and immediate operations with 32-bit wraparound', () => {
    const state = createRv32Machine([
      i(-1, 0, 0, 1),
      i(1, 0, 0, 2),
      r(0, 2, 1, 0, 3),
      r(0x20, 2, 1, 0, 4),
      i(1, 2, 1, 5),
      i(1, 1, 5, 6),
      i(1, 1, 3, 7),
      r(0, 2, 1, 2, 8),
      r(0, 2, 1, 3, 9),
      r(0, 2, 2, 1, 10),
      r(0, 2, 1, 4, 11),
      r(0, 2, 1, 6, 12),
      r(0, 2, 1, 7, 13),
      i(1, 1, 5, 14),
      i(1 | (0x20 << 5), 1, 5, 15),
      ecall,
    ])

    const steps = runRv32(state)
    expect(steps.at(-1)?.trap?.reason).toBe('ecall')
    expect(state.regs[1]).toBe(0xffffffff)
    expect(state.regs[3]).toBe(0)
    expect(state.regs[4]).toBe(0xfffffffe)
    expect(state.regs[5]).toBe(2)
    expect(state.regs[6]).toBe(0x7fffffff)
    expect(state.regs[7]).toBe(0)
    expect(state.regs[8]).toBe(1)
    expect(state.regs[9]).toBe(0)
    expect(state.regs[10]).toBe(2)
    expect(state.regs[11]).toBe(0xfffffffe)
    expect(state.regs[12]).toBe(0xffffffff)
    expect(state.regs[13]).toBe(1)
    expect(state.regs[14]).toBe(0x7fffffff)
    expect(state.regs[15]).toBe(0xffffffff)
  })

  it('keeps x0 hard-wired to zero', () => {
    const state = createRv32Machine([i(123, 0, 0, 0), r(0, 0, 0, 0, 0)])
    runRv32(state)
    expect(state.regs[0]).toBe(0)
  })

  it('executes lui, auipc, jal, and jalr', () => {
    const jump = createRv32Machine([u(0x12345000, 1, 0x37), u(0, 2, 0x17), j(8, 3), i(1, 0, 0, 4), i(2, 0, 0, 4)])
    stepRv32(jump)
    stepRv32(jump)
    stepRv32(jump)
    stepRv32(jump)
    expect(jump.regs[1]).toBe(0x12345000)
    expect(jump.regs[2]).toBe(4)
    expect(jump.regs[3]).toBe(12)
    expect(jump.regs[4]).toBe(2)

    const jalr = createRv32Machine([i(12, 0, 0, 1), i(0, 1, 0, 5, 0x67), i(1, 0, 0, 2), i(2, 0, 0, 2)])
    stepRv32(jalr)
    stepRv32(jalr)
    stepRv32(jalr)
    expect(jalr.regs[5]).toBe(8)
    expect(jalr.regs[2]).toBe(2)
  })

  it('executes taken and not-taken branches', () => {
    const state = createRv32Machine([
      i(1, 0, 0, 1),
      i(1, 0, 0, 2),
      b(8, 2, 1, 0),
      i(1, 0, 0, 3),
      i(2, 0, 0, 3),
      b(8, 2, 1, 1),
      i(7, 0, 0, 4),
    ])
    runRv32(state, 7)
    expect(state.regs[3]).toBe(2)
    expect(state.regs[4]).toBe(7)
  })

  it('loads and stores bytes, halfwords, and words in little-endian memory', () => {
    const state = createRv32Machine([
      i(64, 0, 0, 1),
      i(-128, 0, 0, 2),
      s(0, 2, 1, 0),
      i(0, 1, 0, 3, 0x03),
      i(0, 1, 4, 4, 0x03),
      i(-1, 0, 0, 5),
      s(2, 5, 1, 1),
      i(2, 1, 1, 6, 0x03),
      i(2, 1, 5, 7, 0x03),
      s(4, 5, 1, 2),
      i(4, 1, 2, 8, 0x03),
    ])
    runRv32(state, 11)
    expect(state.regs[3]).toBe(0xffffff80)
    expect(state.regs[4]).toBe(0x80)
    expect(state.regs[6]).toBe(0xffffffff)
    expect(state.regs[7]).toBe(0xffff)
    expect(state.regs[8]).toBe(0xffffffff)
    expect(Array.from(state.memory.slice(64, 72))).toEqual([0x80, 0xbe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  })

  it('halts distinctly on ecall and ebreak', () => {
    const ecallState = createRv32Machine([ecall])
    expect(stepRv32(ecallState).trap?.reason).toBe('ecall')
    expect(ecallState.halted).toBe(true)

    const ebreakState = createRv32Machine([ebreak])
    expect(stepRv32(ebreakState).trap?.reason).toBe('ebreak')
    expect(ebreakState.halted).toBe(true)
  })

  it('reports illegal instructions and fetch traps without throwing', () => {
    const illegal = createRv32Machine([0xffffffff])
    expect(stepRv32(illegal).trap?.reason).toBe('illegal-instruction')

    const misaligned = createRv32Machine([ecall], { pc: 2 })
    expect(stepRv32(misaligned).trap?.reason).toBe('misaligned-fetch')

    const outOfBounds = createRv32Machine([i(1, 0, 0, 1)], { memorySize: 4 })
    stepRv32(outOfBounds)
    expect(stepRv32(outOfBounds).trap?.reason).toBe('memory-out-of-bounds')
  })

  it('reports misaligned and out-of-bounds memory access traps', () => {
    const misalignedLoad = createRv32Machine([i(2, 0, 2, 1, 0x03)])
    expect(stepRv32(misalignedLoad).trap?.reason).toBe('misaligned-load')

    const misalignedStore = createRv32Machine([s(2, 1, 0, 2)])
    expect(stepRv32(misalignedStore).trap?.reason).toBe('misaligned-store')

    const outOfBounds = createRv32Machine([i(64, 0, 2, 1, 0x03)], { memorySize: 64 })
    expect(stepRv32(outOfBounds).trap?.reason).toBe('memory-out-of-bounds')
  })

  it('respects run limits', () => {
    const state = createRv32Machine([j(0, 0)])
    const steps = runRv32(state, 3)
    expect(steps).toHaveLength(3)
    expect(state.halted).toBe(false)
  })

  it('formats words for future UI surfaces', () => {
    expect(formatRv32Word(-1)).toBe('0xffffffff')
  })

  describe('assembled instruction execution', () => {
    it('executes assembled lui and auipc', () => {
      const { state, steps } = runAssembly(
        [
          'lui x1, 305418240',
          'auipc x2, 4096',
          'ecall',
        ].join('\n'),
      )

      expect(steps.at(-1)?.trap?.reason).toBe('ecall')
      expect(state.regs[1]).toBe(0x12345000)
      expect(state.regs[2]).toBe(4100)
    })

    it('executes assembled jal and jalr', () => {
      const jump = runAssembly(
        [
          'jal x3, 8',
          'addi x1, x0, 1',
          'addi x1, x0, 2',
          'ecall',
        ].join('\n'),
      ).state

      expect(jump.regs[1]).toBe(2)
      expect(jump.regs[3]).toBe(4)

      const indirect = runAssembly(
        [
          'addi x5, x0, 12',
          'jalr x4, 0(x5)',
          'addi x2, x0, 1',
          'addi x2, x0, 2',
          'ecall',
        ].join('\n'),
      ).state

      expect(indirect.regs[2]).toBe(2)
      expect(indirect.regs[4]).toBe(8)
    })

    it('executes all assembled branch instructions', () => {
      const { state } = runAssembly(
        [
          'addi x1, x0, 1',
          'addi x2, x0, 1',
          'addi x3, x0, 2',
          'addi x4, x0, -1',
          'beq x1, x2, 8',
          'addi x10, x0, 99',
          'addi x10, x0, 1',
          'bne x1, x3, 8',
          'addi x11, x0, 99',
          'addi x11, x0, 1',
          'blt x4, x1, 8',
          'addi x12, x0, 99',
          'addi x12, x0, 1',
          'bge x1, x4, 8',
          'addi x13, x0, 99',
          'addi x13, x0, 1',
          'bltu x1, x4, 8',
          'addi x14, x0, 99',
          'addi x14, x0, 1',
          'bgeu x4, x1, 8',
          'addi x15, x0, 99',
          'addi x15, x0, 1',
          'ecall',
        ].join('\n'),
      )

      expect(state.regs[10]).toBe(1)
      expect(state.regs[11]).toBe(1)
      expect(state.regs[12]).toBe(1)
      expect(state.regs[13]).toBe(1)
      expect(state.regs[14]).toBe(1)
      expect(state.regs[15]).toBe(1)
    })

    it('executes all assembled load and store instructions', () => {
      const { state } = runAssembly(
        [
          'addi x1, x0, 256',
          'addi x2, x0, -128',
          'sb x2, 0(x1)',
          'lb x3, 0(x1)',
          'lbu x4, 0(x1)',
          'addi x5, x0, -1',
          'sh x5, 2(x1)',
          'lh x6, 2(x1)',
          'lhu x7, 2(x1)',
          'sw x5, 4(x1)',
          'lw x8, 4(x1)',
          'ecall',
        ].join('\n'),
      )

      expect(state.regs[3]).toBe(0xffffff80)
      expect(state.regs[4]).toBe(0x80)
      expect(state.regs[6]).toBe(0xffffffff)
      expect(state.regs[7]).toBe(0xffff)
      expect(state.regs[8]).toBe(0xffffffff)
      expect(Array.from(state.memory.slice(256, 264))).toEqual([0x80, 0xbe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    })

    it('executes all assembled immediate ALU instructions', () => {
      const { state } = runAssembly(
        [
          'addi x1, x0, -1',
          'addi x2, x0, 1',
          'slti x3, x1, 1',
          'sltiu x4, x1, 1',
          'xori x5, x1, 255',
          'ori x6, x0, 240',
          'andi x7, x6, 15',
          'slli x8, x2, 3',
          'srli x9, x1, 1',
          'srai x10, x1, 1',
          'ecall',
        ].join('\n'),
      )

      expect(state.regs[1]).toBe(0xffffffff)
      expect(state.regs[3]).toBe(1)
      expect(state.regs[4]).toBe(0)
      expect(state.regs[5]).toBe(0xffffff00)
      expect(state.regs[6]).toBe(240)
      expect(state.regs[7]).toBe(0)
      expect(state.regs[8]).toBe(8)
      expect(state.regs[9]).toBe(0x7fffffff)
      expect(state.regs[10]).toBe(0xffffffff)
    })

    it('executes all assembled register ALU instructions', () => {
      const { state } = runAssembly(
        [
          'addi x1, x0, -8',
          'addi x2, x0, 3',
          'addi x3, x0, 1',
          'add x4, x1, x2',
          'sub x5, x1, x2',
          'sll x6, x2, x3',
          'slt x7, x1, x2',
          'sltu x8, x1, x2',
          'xor x9, x1, x2',
          'srl x10, x1, x3',
          'sra x11, x1, x3',
          'or x12, x1, x2',
          'and x13, x1, x2',
          'ecall',
        ].join('\n'),
      )

      expect(state.regs[4]).toBe(0xfffffffb)
      expect(state.regs[5]).toBe(0xfffffff5)
      expect(state.regs[6]).toBe(6)
      expect(state.regs[7]).toBe(1)
      expect(state.regs[8]).toBe(0)
      expect(state.regs[9]).toBe(0xfffffffb)
      expect(state.regs[10]).toBe(0x7ffffffc)
      expect(state.regs[11]).toBe(0xfffffffc)
      expect(state.regs[12]).toBe(0xfffffffb)
      expect(state.regs[13]).toBe(0)
    })

    it('executes assembled fence, ecall, and ebreak', () => {
      const fence = runAssembly(
        [
          'addi x1, x0, 1',
          'fence',
          'addi x1, x1, 1',
          'ecall',
        ].join('\n'),
      )
      expect(fence.state.regs[1]).toBe(2)
      expect(fence.steps.at(-1)?.trap?.reason).toBe('ecall')

      const breakpoint = runAssembly('ebreak')
      expect(breakpoint.steps.at(-1)?.trap?.reason).toBe('ebreak')
      expect(breakpoint.state.halted).toBe(true)
    })

    it('executes the Fib(10) loop sample', () => {
      const { state, steps } = runAssembly(
        [
          '# Fib(10): result is x6 = 55',
          'addi x5, x0, 10',
          'addi x6, x0, 0',
          'addi x7, x0, 1',
          'add x8, x6, x7',
          'add x6, x7, x0',
          'add x7, x8, x0',
          'addi x5, x5, -1',
          'bne x5, x0, -16',
          'ecall',
        ].join('\n'),
      )

      expect(steps.at(-1)?.trap?.reason).toBe('ecall')
      expect(state.regs[6]).toBe(55)
      expect(state.regs[7]).toBe(89)
    })

    it('executes the stack-machine-style addition sample', () => {
      const regs = new Uint32Array(32)
      regs[2] = 64 * 1024
      const state = createRv32Machine(
        wordsFromBytes(
          assembleRv32(
            [
              '# Stack machine style: computes 1 + 2',
              'addi x2, x2, -4',
              'addi x5, x0, 1',
              'sw x5, 0(x2)',
              'addi x2, x2, -4',
              'addi x5, x0, 2',
              'sw x5, 0(x2)',
              'lw x5, 0(x2)',
              'addi x2, x2, 4',
              'lw x6, 0(x2)',
              'addi x2, x2, 4',
              'add x7, x6, x5',
              'addi x2, x2, -4',
              'sw x7, 0(x2)',
              'ecall',
            ].join('\n'),
          ),
        ),
        { regs },
      )
      const steps = runRv32(state)

      expect(steps.at(-1)?.trap?.reason).toBe('ecall')
      expect(state.regs[7]).toBe(3)
      expect(readUint32(state.memory, state.regs[2])).toBe(3)
    })
  })
})
