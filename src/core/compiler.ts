import type { ContextEntry, Expr } from './ast'
import type { Instruction, Value } from './ccam'
import { formatProgram } from './ccam'

export type CompileResult = {
  program: Instruction[]
  log: string[]
}

type Compiled = {
  program: Instruction[]
  trace: string[]
}

type ChildTrace = {
  placeholder: string
  trace: string[]
}

export function compile(expr: Expr): CompileResult {
  return compileNormalTerm(expr, [])
}

export function compileNormalTerm(expr: Expr, ctx: ContextEntry[]): CompileResult {
  const compiled = compileNormalTermCore(expr, ctx)
  return { program: compiled.program, log: compiled.trace }
}

export function compileGenerator(expr: Expr, capturedCtx: ContextEntry[], codeVars: string[]): CompileResult {
  const compiled = compileGeneratorCore(expr, capturedCtx, codeVars)
  return { program: compiled.program, log: compiled.trace }
}

function compileNormalTermCore(expr: Expr, ctx: ContextEntry[]): Compiled {
  const judgement = formatJudgement(expr, ctx, [])

  switch (expr.type) {
    case 'int':
      return leaf(judgement, [{ op: 'quote', value: intValue(expr.value) }])
    case 'var': {
      const entry = lookup(ctx, expr.name)
      const path = envPath(ctx, expr.name)
      if (entry.isCode) {
        return leaf(judgement, [
          { op: 'push' },
          ...path,
          { op: 'swap' },
          { op: 'arena' },
          { op: 'cons' },
          { op: 'app' },
          { op: 'call' },
        ])
      }
      return leaf(judgement, path)
    }
    case 'lambda': {
      const bodyCtx = [...ctx, { name: expr.param, isCode: false }]
      const body = compileNormalTermCore(expr.body, bodyCtx)
      const program: Instruction[] = [{ op: 'cur', program: body.program }]
      return composite(judgement, `Cur(${formatJudgement(expr.body, bodyCtx, [])})`, program, [
        { placeholder: formatJudgement(expr.body, bodyCtx, []), trace: body.trace },
      ])
    }
    case 'app': {
      const fn = compileNormalTermCore(expr.fn, ctx)
      const arg = compileNormalTermCore(expr.arg, ctx)
      const program: Instruction[] = [
        { op: 'push' },
        ...fn.program,
        { op: 'swap' },
        ...arg.program,
        { op: 'cons' },
        { op: 'app' },
      ]
      return composite(
        judgement,
        `push; ${formatJudgement(expr.fn, ctx, [])}; swap; ${formatJudgement(expr.arg, ctx, [])}; cons; app`,
        program,
        [
          { placeholder: formatJudgement(expr.fn, ctx, []), trace: fn.trace },
          { placeholder: formatJudgement(expr.arg, ctx, []), trace: arg.trace },
        ],
      )
    }
    case 'binary': {
      const op = expr.op === '+' ? 'add' : 'sub'
      const left = compileNormalTermCore(expr.left, ctx)
      const right = compileNormalTermCore(expr.right, ctx)
      const program: Instruction[] = [
        { op: 'push' },
        ...left.program,
        { op: 'swap' },
        ...right.program,
        { op: 'cons' },
        { op },
      ]
      return composite(
        judgement,
        `push; ${formatJudgement(expr.left, ctx, [])}; swap; ${formatJudgement(expr.right, ctx, [])}; cons; ${op}`,
        program,
        [
          { placeholder: formatJudgement(expr.left, ctx, []), trace: left.trace },
          { placeholder: formatJudgement(expr.right, ctx, []), trace: right.trace },
        ],
      )
    }
    case 'code': {
      const codeVars = ctx.filter((entry) => entry.isCode).map((entry) => entry.name)
      const body = compileGeneratorCore(expr.body, ctx, codeVars)
      const program: Instruction[] = [{ op: 'cur', program: body.program }]
      return composite(judgement, `Cur(${formatGeneratorJudgement(expr.body, ctx, codeVars)})`, program, [
        { placeholder: formatGeneratorJudgement(expr.body, ctx, codeVars), trace: body.trace },
      ])
    }
    case 'lift': {
      const body = compileNormalTermCore(expr.body, ctx)
      const program: Instruction[] = [...body.program, { op: 'cur', program: [{ op: 'lift' }] }]
      return composite(judgement, `${formatJudgement(expr.body, ctx, [])}; Cur(lift)`, program, [
        { placeholder: formatJudgement(expr.body, ctx, []), trace: body.trace },
      ])
    }
    case 'letCogen': {
      const generator = compileNormalTermCore(expr.generator, ctx)
      const bodyCtx = [...ctx, { name: expr.name, isCode: true }]
      const body = compileNormalTermCore(expr.body, bodyCtx)
      const program: Instruction[] = [{ op: 'push' }, ...generator.program, { op: 'cons' }, ...body.program]
      return composite(
        judgement,
        `push; ${formatJudgement(expr.generator, ctx, [])}; cons; ${formatJudgement(expr.body, bodyCtx, [])}`,
        program,
        [
          { placeholder: formatJudgement(expr.generator, ctx, []), trace: generator.trace },
          { placeholder: formatJudgement(expr.body, bodyCtx, []), trace: body.trace },
        ],
      )
    }
  }
}

function compileGeneratorCore(expr: Expr, capturedCtx: ContextEntry[], codeVars: string[]): Compiled {
  const judgement = formatGeneratorJudgement(expr, capturedCtx, codeVars)

  switch (expr.type) {
    case 'int':
      return leaf(judgement, [{ op: 'emit', instruction: { op: 'quote', value: intValue(expr.value) } }])
    case 'var': {
      const entry = lookup(capturedCtx, expr.name)
      const path = envPath(capturedCtx, expr.name)
      if (entry.isCode) {
        if (codeVars.includes(expr.name)) return leaf(judgement, codeVariableSubstitution(path))
        return leaf(judgement, emitSequence([{ op: 'push' }, ...path, { op: 'swap' }, { op: 'arena' }, { op: 'cons' }, { op: 'app' }, { op: 'call' }]))
      }
      return leaf(
        judgement,
        path.map((instruction) => ({ op: 'emit', instruction }) as Instruction),
      )
    }
    case 'lambda': {
      const bodyCtx = [...capturedCtx, { name: expr.param, isCode: false }]
      const body = compileGeneratorCore(expr.body, bodyCtx, codeVars)
      const program: Instruction[] = [
        { op: 'push' },
        { op: 'push' },
        { op: 'fst' },
        { op: 'swap' },
        { op: 'arena' },
        { op: 'cons' },
        ...body.program,
        { op: 'snd' },
        { op: 'swap' },
        { op: 'id' },
        { op: 'cons' },
        { op: 'merge' },
      ]
      return composite(
        judgement,
        `push; push; fst; swap; arena; cons; ${formatGeneratorJudgement(expr.body, bodyCtx, codeVars)}; snd; swap; id; cons; merge`,
        program,
        [{ placeholder: formatGeneratorJudgement(expr.body, bodyCtx, codeVars), trace: body.trace }],
      )
    }
    case 'app': {
      const fn = compileGeneratorCore(expr.fn, capturedCtx, codeVars)
      const arg = compileGeneratorCore(expr.arg, capturedCtx, codeVars)
      const program = [
        ...emitSequence([{ op: 'push' }]),
        ...fn.program,
        ...emitSequence([{ op: 'swap' }]),
        ...arg.program,
        ...emitSequence([{ op: 'cons' }, { op: 'app' }]),
      ] as Instruction[]
      return composite(
        judgement,
        `emit(push); ${formatGeneratorJudgement(expr.fn, capturedCtx, codeVars)}; emit(swap); ${formatGeneratorJudgement(expr.arg, capturedCtx, codeVars)}; emit(cons); emit(app)`,
        program,
        [
          { placeholder: formatGeneratorJudgement(expr.fn, capturedCtx, codeVars), trace: fn.trace },
          { placeholder: formatGeneratorJudgement(expr.arg, capturedCtx, codeVars), trace: arg.trace },
        ],
      )
    }
    case 'binary': {
      const op = expr.op === '+' ? 'add' : 'sub'
      const left = compileGeneratorCore(expr.left, capturedCtx, codeVars)
      const right = compileGeneratorCore(expr.right, capturedCtx, codeVars)
      const program = [
        ...emitSequence([{ op: 'push' }]),
        ...left.program,
        ...emitSequence([{ op: 'swap' }]),
        ...right.program,
        ...emitSequence([{ op: 'cons' }, { op }]),
      ] as Instruction[]
      return composite(
        judgement,
        `emit(push); ${formatGeneratorJudgement(expr.left, capturedCtx, codeVars)}; emit(swap); ${formatGeneratorJudgement(expr.right, capturedCtx, codeVars)}; emit(cons); emit(${op})`,
        program,
        [
          { placeholder: formatGeneratorJudgement(expr.left, capturedCtx, codeVars), trace: left.trace },
          { placeholder: formatGeneratorJudgement(expr.right, capturedCtx, codeVars), trace: right.trace },
        ],
      )
    }
    case 'lift': {
      const body = compileGeneratorCore(expr.body, capturedCtx, codeVars)
      const program: Instruction[] = [
        ...body.program,
        { op: 'push' },
        { op: 'push' },
        { op: 'fst' },
        { op: 'swap' },
        { op: 'arena' },
        { op: 'cons' },
        { op: 'emit', instruction: { op: 'lift' } },
        { op: 'snd' },
        { op: 'swap' },
        { op: 'id' },
        { op: 'cons' },
        { op: 'merge' },
      ]
      return composite(judgement, `${formatGeneratorJudgement(expr.body, capturedCtx, codeVars)}; push; push; fst; swap; arena; cons; emit(lift); snd; swap; id; cons; merge`, program, [
        { placeholder: formatGeneratorJudgement(expr.body, capturedCtx, codeVars), trace: body.trace },
      ])
    }
    case 'code': {
      const nested = compileGeneratorCore(expr.body, capturedCtx, codeVars)
      const program: Instruction[] = [
        { op: 'push' },
        { op: 'fst' },
        { op: 'cur', program: nested.program },
        { op: 'swap' },
        { op: 'snd' },
        { op: 'cons' },
        { op: 'lift' },
      ]
      return composite(
        judgement,
        `push; fst; Cur(${formatGeneratorJudgement(expr.body, capturedCtx, codeVars)}); swap; snd; cons; lift`,
        program,
        [{ placeholder: formatGeneratorJudgement(expr.body, capturedCtx, codeVars), trace: nested.trace }],
      )
    }
    case 'letCogen': {
      const generator = compileGeneratorCore(expr.generator, capturedCtx, codeVars)
      const bodyCtx = [...capturedCtx, { name: expr.name, isCode: true }]
      const body = compileGeneratorCore(expr.body, bodyCtx, codeVars)
      const program: Instruction[] = [
        ...emitSequence([{ op: 'push' }]),
        ...generator.program,
        ...emitSequence([{ op: 'cons' }]),
        ...body.program,
      ]
      return composite(judgement, `emit(push); ${formatGeneratorJudgement(expr.generator, capturedCtx, codeVars)}; emit(cons); ${formatGeneratorJudgement(expr.body, bodyCtx, codeVars)}`, program, [
        { placeholder: formatGeneratorJudgement(expr.generator, capturedCtx, codeVars), trace: generator.trace },
        { placeholder: formatGeneratorJudgement(expr.body, bodyCtx, codeVars), trace: body.trace },
      ])
    }
  }
}

function leaf(judgement: string, program: Instruction[]): Compiled {
  return { program, trace: [judgement, formatProgram(program)] }
}

function composite(judgement: string, expansion: string, program: Instruction[], children: ChildTrace[]): Compiled {
  const trace = [judgement]
  let current = expansion
  trace.push(current)

  for (const [childIndex, child] of children.entries()) {
    current = replaceOnce(current, child.placeholder, markChild(child.placeholder, childIndex)).value
    let childCurrent = child.placeholder
    for (const replacement of child.trace.slice(1)) {
      const replaced = replaceOnce(current, markChild(childCurrent, childIndex), markChild(replacement, childIndex))
      current = replaced.value
      if (replaced.didReplace) childCurrent = replacement
      trace.push(unmarkChildren(current))
    }
    current = unmarkChildren(current)
  }

  const finalProgram = formatProgram(program)
  if (trace.at(-1) !== finalProgram) trace.push(finalProgram)
  return { program, trace: dedupeAdjacent(trace) }
}

function replaceOnce(input: string, search: string, replacement: string): { value: string; didReplace: boolean } {
  const index = input.indexOf(search)
  if (index < 0) return { value: input, didReplace: false }
  return {
    value: `${input.slice(0, index)}${replacement}${input.slice(index + search.length)}`,
    didReplace: true,
  }
}

function dedupeAdjacent(lines: string[]): string[] {
  return lines.filter((line, index) => index === 0 || line !== lines[index - 1])
}

function markChild(value: string, index: number): string {
  return `__TRACE_CHILD_${index}_START__${value}__TRACE_CHILD_${index}_END__`
}

function unmarkChildren(value: string): string {
  return value.replaceAll(/__TRACE_CHILD_\d+_(?:START|END)__/g, '')
}

function emitSequence(program: Instruction[]): Instruction[] {
  return program.map((instruction) => ({ op: 'emit', instruction }) as Instruction)
}

function codeVariableSubstitution(path: Instruction[]): Instruction[] {
  return [
    { op: 'push' },
    { op: 'push' },
    { op: 'fst' },
    ...path,
    { op: 'swap' },
    { op: 'snd' },
    { op: 'cons' },
    { op: 'app' },
    { op: 'snd' },
    { op: 'swap' },
  ]
}

function envPath(ctx: ContextEntry[], name: string): Instruction[] {
  const index = ctx.findIndex((entry) => entry.name === name)
  if (index < 0) throw new Error(`Unbound variable: ${name}`)
  const depthFromRight = ctx.length - index - 1
  const path: Instruction[] = Array.from({ length: depthFromRight }, () => ({ op: 'fst' }) as Instruction)
  path.push({ op: 'snd' })
  return path
}

function lookup(ctx: ContextEntry[], name: string): ContextEntry {
  const entry = [...ctx].reverse().find((item) => item.name === name)
  if (!entry) throw new Error(`Unbound variable: ${name}`)
  return entry
}

function intValue(value: number): Value {
  return { type: 'int', value }
}

function formatExpr(expr: Expr): string {
  switch (expr.type) {
    case 'int':
      return String(expr.value)
    case 'var':
      return expr.name
    case 'lambda':
      return `fn ${expr.param} => ${formatExpr(expr.body)}`
    case 'app':
      return `${parenthesize(expr.fn)} ${parenthesize(expr.arg)}`
    case 'binary':
      return `${parenthesize(expr.left)} ${expr.op} ${parenthesize(expr.right)}`
    case 'code':
      return `code ${parenthesize(expr.body)}`
    case 'lift':
      return `lift ${parenthesize(expr.body)}`
    case 'letCogen':
      return `let cogen ${expr.name} = ${formatExpr(expr.generator)} in ${formatExpr(expr.body)} end`
  }
}

function parenthesize(expr: Expr): string {
  if (expr.type === 'int' || expr.type === 'var') return formatExpr(expr)
  return `(${formatExpr(expr)})`
}

function formatContexts(ctx: ContextEntry[], codeVars: string[], includeLambda: boolean): string {
  const omega = ctx.filter((entry) => !entry.isCode).map((entry) => entry.name)
  const lambda = ctx.filter((entry) => entry.isCode || codeVars.includes(entry.name)).map((entry) => entry.name)
  const lambdaPart = includeLambda || lambda.length > 0 ? ` Λ=${formatContext(lambda)}` : ''
  return `Ω=${formatContext(omega)}${lambdaPart}`
}

function formatJudgement(expr: Expr, ctx: ContextEntry[], codeVars: string[], includeLambda = false): string {
  return `[[ ${formatExpr(expr)} ]] ${formatContexts(ctx, codeVars, includeLambda)}`
}

function formatGeneratorJudgement(expr: Expr, ctx: ContextEntry[], codeVars: string[]): string {
  return formatJudgement(expr, ctx, codeVars, true)
}

function formatContext(names: string[]): string {
  return names.length === 0 ? '∅' : names.join(',')
}
