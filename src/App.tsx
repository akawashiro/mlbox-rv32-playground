import { useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import './App.css'
import readme from '../README.md?raw'
import { compileCcamToRv32 } from './core/ccam-rv32'
import { compile } from './core/mlbox-ccam'
import { formatProgram, formatValue, parseProgram, run } from './core/ccam'
import { parse } from './core/mlbox-expr-parser'
import { assembleRv32, disassembleRv32, disassembleRv32Word } from './core/riscv-asm'
import {
  createRv32Machine,
  formatRv32Instruction,
  formatRv32Register,
  formatRv32Word,
  stepRv32,
} from './core/riscv-emu'
import type { Rv32State, Rv32StepResult } from './core/riscv-emu'

const samples = [
  {
    name: 'a + b',
    source: `3 + 5`,
  },
  {
    name: 'minimal code run',
    source: `let cogen result = code 1 in
  result
end`,
  },
  {
    name: 'minimal lift run',
    source: `let cogen result = lift 42 in
  result
end`,
  },
  {
    name: 'lifted identity function',
    source: `let cogen result = lift (fn x => x) in
  result 3
end`,
  },
  {
    name: 'lifted code pipeline',
    source: `let cogen c0 = lift (code 1) in
  let cogen c1 = code c0 in
    let cogen c2 = c1 in
      c2
    end
  end
end`,
  },
  {
    name: 'let cogen + lift',
    source: `let cogen result = (
  let cogen a = lift (6 + 7) in
    code (a + 8)
  end
) in
  result
end`,
  },
  {
    name: 'let cogen + code',
    source: `let cogen result = (
  let cogen u = code 1 in
    code u
  end
) in
  result
end`,
  },
  {
    name: 'nested code subtraction',
    source: `let cogen u = code (1 - 2) in
  let cogen v = code u in
    v
  end
end`,
  },
  {
    name: 'arithmetic',
    source: `6 + 7 + 8`,
  },
  {
    name: 'lambda application',
    source: `(fn x => x + x + 1) 9`,
  },
  {
    name: 'curried lambda application',
    source: `(fn x => (fn y => x + y)) 1 2`,
  },
  {
    name: 'identity application',
    source: `(fn x => x) 1`,
  },
  {
    name: 'constant application',
    source: `(fn x => 2) 1`,
  },
  {
    name: 'code run',
    source: `let cogen result = code ((20 + 1) + 2) in
  result
end`,
  },
  {
    name: 'generated application',
    source: `let cogen u = code ((fn x => x) 1) in
  u
end`,
  },
  {
    name: 'compile application in code',
    source: `code ((fn x => x) 1)`,
  },
  {
    name: 'generated function',
    source: `(let cogen f = code (fn x => x + 10) in
  f
end) 32`,
  },
  {
    name: 'code substitution',
    source: `let cogen result = (
  let cogen base = lift 40 in
    let cogen delta = lift 2 in
      code (base + delta)
    end
  end
) in
  result
end`,
  },
  {
    name: 'paper: merge + lift to int',
    source: `let cogen generated = code (fn x => x + 10) in
  let cogen result = (
    let cogen a = lift (6 + 7) in
      code (a + 8)
    end
  ) in
    result
  end
end`,
  },
  {
    name: 'Figure 4: normal variable',
    source: `fn x => x`,
  },
  {
    name: 'Figure 4: normal lambda',
    source: `fn x => x + 1`,
  },
  {
    name: 'Figure 4: normal application',
    source: `(fn x => x) 1`,
  },
  {
    name: 'Figure 4: normal code variable',
    source: `let cogen u = code 1 in
  u
end`,
  },
  {
    name: 'Figure 4: normal code',
    source: `code 1`,
  },
  {
    name: 'Figure 4: normal lift',
    source: `lift (1 + 2)`,
  },
  {
    name: 'Figure 4: normal let cogen',
    source: `let cogen u = code 1 in
  2
end`,
  },
  {
    name: 'Figure 4: generator variable',
    source: `(fn x => code x) 1`,
  },
  {
    name: 'Figure 4: generator lambda',
    source: `code (fn x => x)`,
  },
  {
    name: 'Figure 4: generator application',
    source: `code ((fn x => x) 1)`,
  },
  {
    name: 'Figure 4: generator code variable in Omega',
    source: `code (let cogen u = code 1 in
  u
end)`,
  },
  {
    name: 'nested let cogen inside code',
    source: `let cogen v = (code (let cogen u = code 1 in
  u
end)) in
  v
end`,
  },
  {
    name: 'Figure 4: generator code variable in Lambda',
    source: `let cogen u = code 1 in
  code u
end`,
  },
  {
    name: 'Figure 4: generator nested code',
    source: `code (code 1)`,
  },
  {
    name: 'nested code',
    source: `let cogen u = code (code 1) in
  u
end`,
  },
  {
    name: 'Figure 4: generator lift',
    source: `code (lift 1)`,
  },
  {
    name: 'lift inside generated code',
    source: `let cogen u = code (lift 1) in
  u
end`,
  },
  {
    name: 'Figure 4: generator let cogen',
    source: `code (let cogen u = code 1 in
  2
end)`,
  },
  {
    name: 'app inside generated function',
    source: `let cogen f = code (fn x => (fn y => y) x) in
  f 1
end`,
  },
]

const sortedSamples = [...samples].sort((left, right) => left.name.localeCompare(right.name))

const rv32MemorySize = 256 * 1024
const rv32InitialSp = rv32MemorySize - 4
const rv32InitialHp = 0x00020000
const rv32InitialReturnStack = 0x0001fffc
const rv32InitialCodeHeap = 0x00030000
const rv32DisassemblyRadius = 6
const rv32StackRowCount = 10
const rv32RunToTrapLimit = 10000

const rv32AssemblySamples = [
  {
    name: 'Forward/backward jal labels',
    source: [
      'jal x1, target',
      'addi x2, x0, 1',
      'target: addi x3, x0, 2',
      'jal x0, target',
    ].join('\n'),
  },
  {
    name: 'Forward/backward branch labels',
    source: ['start:', 'beq x1, x2, done', 'addi x3, x0, 1', 'done: bne x1, x2, start'].join('\n'),
  },
  {
    name: 'PC-relative label address',
    source: [
      '.Ltarget_addr:',
      'auipc x8, %pcrel_hi(target)',
      'addi x8, x8, %pcrel_lo(.Ltarget_addr)',
      'jalr x0, 0(x8)',
      'addi x9, x0, 1',
      'target: ebreak',
    ].join('\n'),
  },
  {
    name: 'Comments',
    source: [
      '# full-line comment',
      'addi x1, x0, 1 # trailing comment',
      '; another full-line comment',
      'addi x2, x1, 2 ; semicolon trailing comment',
    ].join('\n'),
  },
]

const sortedRv32AssemblySamples = [...rv32AssemblySamples].sort((left, right) => left.name.localeCompare(right.name))

type Rv32UiState = {
  machine: Rv32State | null
  steps: Rv32StepResult[]
  error: string | null
}

type Rv32DisassemblyRow = {
  address: number
  word: number | null
  text: string
  current: boolean
}

type Rv32MemoryRow = {
  address: number
  bytes: string
  target: string
  includesPointer: boolean
}

type AssembledRv32Result = {
  source: string | null
  error: string | null
}

type AppTab = 'playground' | 'readme'

function compileMlboxSource(source: string) {
  try {
    const ast = parse(source)
    const compiled = compile(ast)
    return { ast, compiled, error: null }
  } catch (error) {
    return { ast: null, compiled: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function runCcamProgram(source: string) {
  try {
    const program = parseProgram(source)
    const executed = run(program)
    return { program, executed, error: null }
  } catch (error) {
    return { program: null, executed: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function compileCcamProgramToRv32Source(source: string) {
  try {
    return { assembly: compileCcamToRv32(source), error: null }
  } catch (error) {
    return { assembly: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function assembleAndDisassembleRv32Source(source: string): AssembledRv32Result {
  try {
    return { source: disassembleRv32(assembleRv32(source)), error: null }
  } catch (error) {
    return { source: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function countAssemblyInstructions(source: string): number {
  return source
    .split('\n')
    .map((line) => line.split(/[;#]/u)[0].trim())
    .filter((line) => line.length > 0).length
}

function defaultCcamProgramSource(): string {
  const result = compileMlboxSource(samples[0].source)
  return result.compiled ? formatProgram(result.compiled.program) : '.'
}

function defaultCcamRv32Source(): string {
  const result = compileCcamProgramToRv32Source(defaultCcamProgramSource())
  return result.assembly ?? ''
}

function defaultAssembledRv32Source(): string {
  const result = assembleAndDisassembleRv32Source(defaultCcamRv32Source())
  return result.source ?? ''
}

function createRv32UiState(source: string): Rv32UiState {
  try {
    const program = wordsFromBytes(assembleRv32(source))
    const regs = new Uint32Array(32)
    regs[2] = rv32InitialSp
    regs[3] = rv32InitialHp
    regs[4] = rv32InitialReturnStack
    regs[9] = rv32InitialCodeHeap
    return {
      machine: createRv32Machine(program, { regs, memorySize: rv32MemorySize }),
      steps: [],
      error: null,
    }
  } catch (error) {
    return {
      machine: null,
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function cloneRv32Machine(machine: Rv32State): Rv32State {
  return {
    pc: machine.pc,
    regs: new Uint32Array(machine.regs),
    memory: new Uint8Array(machine.memory),
    halted: machine.halted,
    trap: machine.trap,
  }
}

function wordsFromBytes(bytes: Uint8Array): number[] {
  const words: number[] = []
  for (let index = 0; index < bytes.length; index += 4) {
    words.push(readUint32(bytes, index))
  }
  return words
}

function rv32DisassemblyRows(machine: Rv32State): Rv32DisassemblyRow[] {
  const pc = machine.pc
  const center = Math.floor(pc / 4) * 4
  const start = Math.max(0, center - rv32DisassemblyRadius * 4)
  const rows: Rv32DisassemblyRow[] = []

  for (let address = start; address <= center + rv32DisassemblyRadius * 4; address += 4) {
    if (address > machine.memory.length - 4) {
      rows.push({ address, word: null, text: 'outside memory', current: address === center })
      continue
    }

    const word = readUint32(machine.memory, address)
    try {
      rows.push({ address, word, text: disassembleRv32Word(word, address), current: address === center })
    } catch (error) {
      rows.push({
        address,
        word,
        text: error instanceof Error ? error.message : String(error),
        current: address === center,
      })
    }
  }

  return rows
}

function rv32StackRows(machine: Rv32State, pointer: number): Rv32MemoryRow[] {
  const rowSize = 4
  const start = alignDown(Math.min(pointer, machine.memory.length - rowSize), rowSize)
  const rowsBeforePointer = Math.floor(rv32StackRowCount / 2)
  const clampedStart = Math.max(0, Math.min(machine.memory.length - rowSize, start - rowSize * rowsBeforePointer))
  const rows: Rv32MemoryRow[] = []

  for (let address = clampedStart; address < clampedStart + rowSize * rv32StackRowCount && address < machine.memory.length; address += rowSize) {
    const cellPointer = readUint32(machine.memory, address)
    rows.push({
      address,
      bytes: formatMemoryBytes(machine.memory, address, rowSize),
      target: canReadBytes(machine.memory, cellPointer, 8) ? formatMemoryBytes(machine.memory, cellPointer, 8) : 'outside memory',
      includesPointer: pointer >= address && pointer < address + rowSize,
    })
  }

  return rows
}

function rv32RegisterLabel(index: number): string {
  switch (index) {
    case 1:
      return `${formatRv32Register(index)} (Call Stack Pointer)`
    case 2:
      return `${formatRv32Register(index)} (CCAM Stack Pointer)`
    case 3:
      return `${formatRv32Register(index)} (Heap Head Pointer)`
    case 9:
      return `${formatRv32Register(index)} (Code Heap Pointer)`
    default:
      return formatRv32Register(index)
  }
}

function readUint32(bytes: Uint8Array, address: number): number {
  return (bytes[address] | (bytes[address + 1] << 8) | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0
}

function alignDown(value: number, alignment: number): number {
  return value - (value % alignment)
}

function canReadBytes(bytes: Uint8Array, address: number, length: number): boolean {
  return address <= bytes.length - length
}

function formatMemoryBytes(bytes: Uint8Array, address: number, length: number): string {
  return Array.from(bytes.slice(address, address + length))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ')
}

function App() {
  return <Workbench />
}

function Workbench() {
  const [activeTab, setActiveTab] = useState<AppTab>('playground')
  const [source, setSource] = useState(samples[0].source)
  const [ccamProgramSource, setCcamProgramSource] = useState(defaultCcamProgramSource)
  const [ccamRv32Source, setCcamRv32Source] = useState(defaultCcamRv32Source)
  const [assembledRv32Source, setAssembledRv32Source] = useState(defaultAssembledRv32Source)
  const [assembledRv32Error, setAssembledRv32Error] = useState<string | null>(null)
  const [rv32State, setRv32State] = useState<Rv32UiState>(() => createRv32UiState(defaultAssembledRv32Source()))

  const compileResult = useMemo(() => compileMlboxSource(source), [source])
  const ccamResult = useMemo(() => runCcamProgram(ccamProgramSource), [ccamProgramSource])
  const ccamToRv32Result = useMemo(() => compileCcamProgramToRv32Source(ccamProgramSource), [ccamProgramSource])

  const rv32Machine = rv32State.machine
  const rv32Trap = rv32Machine?.trap ?? rv32State.steps.at(-1)?.trap
  const rv32LastStep = rv32State.steps.at(-1)
  const rv32Disassembly = rv32Machine ? rv32DisassemblyRows(rv32Machine) : []
  const rv32CallStack = rv32Machine ? rv32StackRows(rv32Machine, rv32Machine.regs[4]) : []
  const rv32CcamStack = rv32Machine ? rv32StackRows(rv32Machine, rv32Machine.regs[2]) : []

  function updateMlboxSource(nextSource: string): void {
    setSource(nextSource)
    const nextResult = compileMlboxSource(nextSource)
    if (nextResult.compiled) updateCcamProgramSource(formatProgram(nextResult.compiled.program))
  }

  function updateCcamProgramSource(nextSource: string): void {
    setCcamProgramSource(nextSource)
    const nextResult = compileCcamProgramToRv32Source(nextSource)
    if (nextResult.error !== null) return
    updateCcamRv32Source(nextResult.assembly)
  }

  function updateCcamRv32Source(nextSource: string): void {
    setCcamRv32Source(nextSource)
    const nextResult = assembleAndDisassembleRv32Source(nextSource)
    setAssembledRv32Error(nextResult.error)
    if (nextResult.source === null) return
    setAssembledRv32Source(nextResult.source)
    setRv32State(createRv32UiState(nextResult.source))
  }

  function updateAssembledRv32Source(nextSource: string): void {
    setAssembledRv32Source(nextSource)
    setRv32State(createRv32UiState(nextSource))
  }

  function resetRv32(): void {
    setRv32State(createRv32UiState(assembledRv32Source))
  }

  function selectRv32AssemblySample(name: string): void {
    const sample = sortedRv32AssemblySamples.find((item) => item.name === name)
    if (!sample) return
    updateCcamRv32Source(sample.source)
  }

  function stepRv32Once(): void {
    setRv32State((current) => {
      if (!current.machine || current.machine.halted) return current
      const machine = cloneRv32Machine(current.machine)
      const step = stepRv32(machine)
      return { machine, steps: [...current.steps, step], error: null }
    })
  }

  function runRv32UntilTrap(): void {
    setRv32State((current) => {
      if (!current.machine || current.machine.halted) return current
      const machine = cloneRv32Machine(current.machine)
      const steps: Rv32StepResult[] = []

      for (let count = 0; count < rv32RunToTrapLimit && !machine.halted; count += 1) {
        steps.push(stepRv32(machine))
      }

      const error = machine.halted ? null : `RV32I run limit exceeded (${rv32RunToTrapLimit} steps)`
      return { machine, steps: [...current.steps, ...steps], error }
    })
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>ML^box to CCAM to RV32I</h1>
        </div>
        <a href="https://github.com/akawashiro/mlbox-rv32-playground" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>

      <nav className="app-tabs" aria-label="Main sections" role="tablist">
        <button
          type="button"
          id="playground-tab"
          role="tab"
          aria-selected={activeTab === 'playground'}
          aria-controls="playground-panel"
          onClick={() => setActiveTab('playground')}
        >
          Playground
        </button>
        <button
          type="button"
          id="readme-tab"
          role="tab"
          aria-selected={activeTab === 'readme'}
          aria-controls="readme-panel"
          onClick={() => setActiveTab('readme')}
        >
          README
        </button>
      </nav>

      {activeTab === 'playground' ? (
        <section className="workspace" id="playground-panel" role="tabpanel" aria-labelledby="playground-tab">
          <section className="panel input-panel">
            <div className="panel-header">
              <h2>ML^box</h2>
              <label className="sample-picker">
                <span>Sample</span>
                <select
                  value={samples.find((sample) => sample.source === source)?.name ?? 'custom'}
                  onChange={(event) => {
                    const sample = sortedSamples.find((item) => item.name === event.target.value)
                    if (sample) updateMlboxSource(sample.source)
                  }}
                >
                  {samples.find((sample) => sample.source === source) ? null : <option value="custom">Custom</option>}
                  {sortedSamples.map((sample) => (
                    <option key={sample.name} value={sample.name}>
                      {sample.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <textarea
              value={source}
              onChange={(event) => updateMlboxSource(event.target.value)}
              spellCheck={false}
              aria-label="ML^box source"
            />
          </section>

        <section className="panel compile-panel">
          <div className="panel-header">
            <h2>ML^box to CCAM Compile Trace</h2>
          </div>
          {compileResult.error ? (
            <pre className="error">{compileResult.error}</pre>
          ) : (
            <ol className="trace-list">
              {compileResult.compiled!.log.map((line, index) => (
                <li key={`${index}-${line}`}>
                  <code>{line}</code>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="panel ccam-program-panel">
          <div className="panel-header">
            <h2>CCAM Program (from ML^box)</h2>
          </div>
          <textarea
            className="ccam-program-source"
            value={ccamProgramSource}
            onChange={(event) => updateCcamProgramSource(event.target.value)}
            spellCheck={false}
            aria-label="CCAM Program from ML^box source"
          />
        </section>

        <section className="panel run-panel">
          <div className="panel-header">
            <h2>CCAM Emulator</h2>
            {!ccamResult.error && <span>{ccamResult.executed!.transitions.length - 1} transitions</span>}
          </div>
          {ccamResult.error ? (
            <pre className="error">{ccamResult.error}</pre>
          ) : (
            <>
              <div className="summary">
                <span>result</span>
                <code>{formatValue(ccamResult.executed!.value)}</code>
              </div>
              <div className="transition-table">
                <div className="row heading">
                  <span>#</span>
                  <span>Stack</span>
                  <span>Program</span>
                </div>
                {ccamResult.executed!.transitions.map((transition) => (
                  <div className="row" key={transition.step}>
                    <span>{transition.step}</span>
                    <code>{transition.stack}</code>
                    <code>{transition.program}</code>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="panel ccam-rv32-compile-panel">
          <div className="panel-header">
            <h2>RV32I Assemble (from CCAM Program)</h2>
            <label className="sample-picker">
              <span>Sample</span>
              <select
                value={rv32AssemblySamples.find((sample) => sample.source === ccamRv32Source)?.name ?? 'custom'}
                onChange={(event) => selectRv32AssemblySample(event.target.value)}
              >
                {rv32AssemblySamples.find((sample) => sample.source === ccamRv32Source) ? null : <option value="custom">Custom</option>}
                {sortedRv32AssemblySamples.map((sample) => (
                  <option key={sample.name} value={sample.name}>
                    {sample.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {ccamToRv32Result.error ? (
            <pre className="error">{ccamToRv32Result.error}</pre>
          ) : (
            <div className="summary">
              <span>status</span>
              <code>{countAssemblyInstructions(ccamRv32Source)} RV32I instructions generated</code>
            </div>
          )}
          <textarea
            className="rv32-compiler-source"
            value={ccamRv32Source}
            onChange={(event) => updateCcamRv32Source(event.target.value)}
            spellCheck={false}
            aria-label="CCAM to RV32I compiler output"
          />
        </section>

        <section className="panel assembled-rv32-panel">
          <div className="panel-header">
            <h2>RV32I Machine Code (from RV32I Assembly)</h2>
            <span>{assembledRv32Error ? 'failed' : 'success'}</span>
          </div>
          <div className="summary">
            <span>status</span>
            <code>{countAssemblyInstructions(assembledRv32Source)} RV32I instructions loaded</code>
          </div>
          <textarea
            className="assembled-rv32-source"
            value={assembledRv32Source}
            onChange={(event) => updateAssembledRv32Source(event.target.value)}
            spellCheck={false}
            aria-label="Assembled RV32I source"
          />
          {assembledRv32Error && <pre className="error">{assembledRv32Error}</pre>}
        </section>

        <section className="panel riscv-panel">
          <div className="panel-header">
            <h2>RISC-V Emulator</h2>
            <span>{rv32Machine ? `${rv32State.steps.length} steps` : 'not loaded'}</span>
          </div>
          <div className="riscv-layout">
            <div className="riscv-editor">
              <div className="riscv-toolbar">
                <button type="button" onClick={resetRv32}>
                  Reset
                </button>
                <button type="button" onClick={stepRv32Once} disabled={!rv32Machine || rv32Machine.halted}>
                  Step
                </button>
                <button type="button" onClick={runRv32UntilTrap} disabled={!rv32Machine || rv32Machine.halted}>
                  Run to Trap
                </button>
              </div>
              <textarea
                className="riscv-source"
                value={assembledRv32Source}
                readOnly
                spellCheck={false}
                aria-label="RISC-V assembly source"
              />
              {rv32State.error && <pre className="error">{rv32State.error}</pre>}
            </div>

            <div className="riscv-state">
              <div className="riscv-status">
                <div>
                  <span>PC</span>
                  <code>{rv32Machine ? formatRv32Word(rv32Machine.pc) : '-'}</code>
                </div>
                <div>
                  <span>Status</span>
                  <code>{rv32Machine?.halted ? rv32Trap?.reason ?? 'halted' : 'running'}</code>
                </div>
                <div>
                  <span>Last</span>
                  <code>{rv32LastStep ? formatRv32Instruction(rv32LastStep.instruction) : '-'}</code>
                </div>
              </div>
              {rv32Trap && <pre className="trap">{rv32Trap.message}</pre>}

              <div className="riscv-grid">
                <section className="riscv-block">
                  <h3>Registers</h3>
                  <div className="register-grid">
                    {rv32Machine
                      ? Array.from(rv32Machine.regs).map((value, index) => (
                          <div className="register-cell" key={index}>
                            <span>{rv32RegisterLabel(index)}</span>
                            <code>{formatRv32Word(value)}</code>
                          </div>
                        ))
                      : null}
                  </div>
                </section>

                <section className="riscv-block">
                  <h3>Disassembly</h3>
                  <div className="disassembly-list">
                    {rv32Disassembly.map((row) => (
                      <div className={row.current ? 'disassembly-row current' : 'disassembly-row'} key={row.address}>
                        <span>{row.current ? 'PC' : ''}</span>
                        <code>{formatRv32Word(row.address)}</code>
                        <code>{row.word === null ? '--------' : formatRv32Word(row.word)}</code>
                        <code>{row.text}</code>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <div className="memory-grid">
                <section className="riscv-block">
                  <h3>Call Stack</h3>
                  <div className="memory-dump">
                    {rv32CallStack.map((row) => (
                      <div className={row.includesPointer ? 'memory-row current' : 'memory-row'} key={row.address}>
                        <span />
                        <code>{formatRv32Word(row.address)}</code>
                        <code>
                          {row.bytes} -&gt; {row.target}
                        </code>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="riscv-block">
                  <h3>CCAM Stack</h3>
                  <div className="memory-dump">
                    {rv32CcamStack.map((row) => (
                      <div className={row.includesPointer ? 'memory-row current' : 'memory-row'} key={row.address}>
                        <span />
                        <code>{formatRv32Word(row.address)}</code>
                        <code>
                          {row.bytes} -&gt; {row.target}
                        </code>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </section>
      </section>
      ) : (
        <section className="readme-shell" id="readme-panel" role="tabpanel" aria-labelledby="readme-tab">
          <article className="panel markdown-view">
            <Markdown>{readme}</Markdown>
          </article>
        </section>
      )}
    </main>
  )
}

export default App
