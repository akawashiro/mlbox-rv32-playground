export type Value =
  | { type: 'unit' }
  | { type: 'int'; value: number }
  | { type: 'pair'; left: Value; right: Value }
  | { type: 'closure'; env: Value; program: Instruction[] }
  | { type: 'block'; program: Instruction[] }

export type Instruction =
  | { op: 'id' }
  | { op: 'fst' }
  | { op: 'snd' }
  | { op: 'push' }
  | { op: 'swap' }
  | { op: 'cons' }
  | { op: 'app' }
  | { op: 'quote'; value: Value }
  | { op: 'cur'; program: Instruction[] }
  | { op: 'emit'; instruction: Instruction }
  | { op: 'lift' }
  | { op: 'arena' }
  | { op: 'merge' }
  | { op: 'call' }
  | { op: 'add' }
  | { op: 'sub' }

export type Transition = {
  step: number
  stack: string
  program: string
}

export const unit: Value = { type: 'unit' }

export function run(program: Instruction[], env: Value = unit, limit = 300): { value: Value; transitions: Transition[] } {
  const stack: Value[] = [env]
  let instructions = [...program]
  const transitions: Transition[] = []
  let step = 0

  while (instructions.length > 0) {
    if (step >= limit) throw new Error(`CCAM step limit exceeded (${limit})`)
    transitions.push({ step, stack: formatStack(stack), program: formatProgram(instructions) })
    const instruction = instructions.shift()
    if (!instruction) break
    execute(instruction, stack, (extra) => {
      instructions = [...extra, ...instructions]
    })
    step += 1
  }

  transitions.push({ step, stack: formatStack(stack), program: '.' })
  if (stack.length === 0) throw new Error('CCAM stack is empty')
  return { value: stack[0], transitions }
}

function execute(instruction: Instruction, stack: Value[], prepend: (program: Instruction[]) => void): void {
  switch (instruction.op) {
    case 'id':
      return
    case 'fst':
      stack[0] = asPair(stack[0]).left
      return
    case 'snd':
      stack[0] = asPair(stack[0]).right
      return
    case 'push':
      stack.unshift(stack[0])
      return
    case 'swap': {
      const first = stack[0]
      stack[0] = stack[1]
      stack[1] = first
      return
    }
    case 'cons': {
      const right = stack.shift()
      const left = stack.shift()
      if (!left || !right) throw new Error('cons requires two stack values')
      stack.unshift({ type: 'pair', left, right })
      return
    }
    case 'app': {
      const pair = asPair(stack.shift())
      const closure = asClosure(pair.left)
      stack.unshift({ type: 'pair', left: closure.env, right: pair.right })
      prepend(closure.program)
      return
    }
    case 'quote':
      stack[0] = cloneValue(instruction.value)
      return
    case 'cur':
      stack[0] = { type: 'closure', env: stack[0], program: instruction.program }
      return
    case 'emit':
      currentBlock(stack[0]).program.push(instruction.instruction)
      return
    case 'lift': {
      const env = asPair(stack[0])
      asBlock(env.right).program.push({ op: 'quote', value: cloneValue(env.left) })
      return
    }
    case 'arena':
      stack[0] = { type: 'block', program: [] }
      return
    case 'merge': {
      const env = asPair(stack[0])
      const bodyBlock = asBlock(env.left)
      currentBlock(env.right).program.push({ op: 'cur', program: [...bodyBlock.program] })
      stack[0] = env.right
      return
    }
    case 'call': {
      const env = asPair(stack[0])
      const block = asBlock(env.right)
      stack[0] = env.left
      prepend(block.program)
      return
    }
    case 'add':
    case 'sub': {
      const pair = asPair(stack[0])
      const left = asInt(pair.left)
      const right = asInt(pair.right)
      const value = instruction.op === 'add' ? left + right : left - right
      stack[0] = { type: 'int', value }
      return
    }
  }
}

function currentBlock(value: Value): Extract<Value, { type: 'block' }> {
  return asBlock(asPair(value).right)
}

function asPair(value: Value | undefined): Extract<Value, { type: 'pair' }> {
  if (!value || value.type !== 'pair') throw new Error(`Expected pair, got ${formatValue(value)}`)
  return value
}

function asClosure(value: Value): Extract<Value, { type: 'closure' }> {
  if (value.type !== 'closure') throw new Error(`Expected closure, got ${formatValue(value)}`)
  return value
}

function asBlock(value: Value | undefined): Extract<Value, { type: 'block' }> {
  if (!value || value.type !== 'block') throw new Error(`Expected code block, got ${formatValue(value)}`)
  return value
}

function asInt(value: Value): number {
  if (value.type !== 'int') throw new Error(`Expected int, got ${formatValue(value)}`)
  return value.value
}

function cloneValue(value: Value): Value {
  if (value.type === 'pair') return { type: 'pair', left: cloneValue(value.left), right: cloneValue(value.right) }
  if (value.type === 'closure') return { type: 'closure', env: cloneValue(value.env), program: value.program }
  if (value.type === 'block') return { type: 'block', program: [...value.program] }
  return { ...value }
}

export function formatProgram(program: Instruction[]): string {
  if (program.length === 0) return '.'
  return program.map(formatInstruction).join('; ')
}

export function formatInstruction(instruction: Instruction): string {
  switch (instruction.op) {
    case 'quote':
      return `'${formatValue(instruction.value)}`
    case 'cur':
      return `Cur(${formatProgram(instruction.program)})`
    case 'emit':
      return `emit(${formatInstruction(instruction.instruction)})`
    default:
      return instruction.op
  }
}

export function parseProgram(source: string): Instruction[] {
  const trimmed = source.trim()
  if (trimmed === '.') return []
  if (trimmed.length === 0) throw new Error('Expected CCAM program, got empty input')
  return splitTopLevel(trimmed, ';').map(parseInstruction)
}

function parseInstruction(source: string): Instruction {
  const trimmed = source.trim()
  if (trimmed.length === 0) throw new Error('Expected CCAM instruction, got empty input')
  if (trimmed.startsWith("'")) return { op: 'quote', value: parseQuotedValue(trimmed.slice(1), trimmed) }
  if (trimmed.startsWith('Cur(')) return { op: 'cur', program: parseProgram(parenthesizedContent(trimmed, 'Cur')) }
  if (trimmed.startsWith('emit(')) return { op: 'emit', instruction: parseInstruction(parenthesizedContent(trimmed, 'emit')) }

  if (simpleInstructionOps.has(trimmed)) return { op: trimmed as SimpleInstructionOp }
  throw new Error(`Unknown CCAM instruction: ${trimmed}`)
}

function parseQuotedValue(source: string, original: string): Value {
  const trimmed = source.trim()
  if (trimmed === '()') return unit
  if (/^-?\d+$/u.test(trimmed)) return { type: 'int', value: Number(trimmed) }
  throw new Error(`Unsupported CCAM quoted value: ${original}`)
}

function parenthesizedContent(source: string, name: string): string {
  const prefix = `${name}(`
  if (!source.startsWith(prefix) || !source.endsWith(')')) throw new Error(`Invalid CCAM ${name} form: ${source}`)
  const content = source.slice(prefix.length, -1)
  assertBalancedParentheses(content, source)
  return content
}

function splitTopLevel(source: string, delimiter: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth < 0) throw new Error(`Unbalanced CCAM program: ${source}`)
    }
    if (char === delimiter && depth === 0) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
    }
  }

  if (depth !== 0) throw new Error(`Unbalanced CCAM program: ${source}`)
  parts.push(source.slice(start).trim())
  if (parts.some((part) => part.length === 0)) throw new Error(`Empty CCAM instruction in program: ${source}`)
  return parts
}

function assertBalancedParentheses(source: string, original: string): void {
  let depth = 0
  for (const char of source) {
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth < 0) throw new Error(`Unbalanced CCAM instruction: ${original}`)
    }
  }
  if (depth !== 0) throw new Error(`Unbalanced CCAM instruction: ${original}`)
}

type SimpleInstructionOp = Exclude<Instruction['op'], 'quote' | 'cur' | 'emit'>

const simpleInstructionOps = new Set<string>([
  'id',
  'fst',
  'snd',
  'push',
  'swap',
  'cons',
  'app',
  'lift',
  'arena',
  'merge',
  'call',
  'add',
  'sub',
])

export function formatStack(stack: Value[]): string {
  return `[${stack.map(formatValue).join(' :: ')}]`
}

export function formatValue(value: Value | undefined): string {
  if (!value) return '<empty>'
  switch (value.type) {
    case 'unit':
      return '()'
    case 'int':
      return String(value.value)
    case 'pair':
      return `(${formatValue(value.left)}, ${formatValue(value.right)})`
    case 'closure':
      return `[${formatValue(value.env)} : ${formatProgram(value.program)}]`
    case 'block':
      return `{${formatProgram(value.program)}}`
  }
}
