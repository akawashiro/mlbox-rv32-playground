import { describe, expect, it } from 'vitest'
import { compile, compileGenerator, compileNormalTerm } from './mlbox-ccam'
import { formatProgram, formatValue, parseProgram, run } from './ccam'
import type { Instruction, Value } from './ccam'
import { parse } from './parser'

function execute(source: string) {
  const ast = parse(source)
  const compiled = compile(ast)
  return { ...run(compiled.program), compiled }
}

function expectLinesInOrder(log: string[], expected: string[]) {
  let previousIndex = -1
  for (const line of expected) {
    const index = log.findIndex((entry, entryIndex) => entryIndex > previousIndex && entry === line)
    expect(index).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

function intValue(value: number): Value {
  return { type: 'int', value }
}

function pairValue(left: Value, right: Value): Value {
  return { type: 'pair', left, right }
}

function blockValue(program: Instruction[] = []): Value {
  return { type: 'block', program }
}

function closureValue(env: Value, program: Instruction[]): Value {
  return { type: 'closure', env, program }
}

function finalStack(program: Instruction[], env: Value): string {
  const transition = run(program, env).transitions.at(-1)
  if (!transition) throw new Error('missing final transition')
  return transition.stack
}

function expectProgramRoundTrip(program: Instruction[]): void {
  const text1 = formatProgram(program)
  const parsed1 = parseProgram(text1)
  const text2 = formatProgram(parsed1)
  const parsed2 = parseProgram(text2)

  expect(text2).toBe(text1)
  expect(parsed2).toEqual(parsed1)
  expect(parsed1).toEqual(program)
}

describe('ML^box parser/compiler/CCAM', () => {
  it('runs integer arithmetic on the CCAM', () => {
    const result = execute('6 + 7 + 8')
    expect(formatValue(result.value)).toBe('21')
  })

  it('runs lambda application on the CCAM', () => {
    const result = execute('(fn x => x + 1) 41')
    expect(formatValue(result.value)).toBe('42')
  })

  it('evaluates a generated code block', () => {
    const result = execute('let cogen result = code (40 + 2) in result end')
    expect(formatValue(result.value)).toBe('42')
    expect(result.transitions.length).toBeGreaterThan(1)
  })

  it('evaluates the minimal generated code sample', () => {
    const result = execute('let cogen result = code 1 in result end')
    expect(formatValue(result.value)).toBe('1')
  })

  it('specializes a code variable with let cogen', () => {
    const result = execute('let cogen result = (let cogen a = lift (6 + 7) in code (a + 8) end) in result end')
    expect(formatValue(result.value)).toBe('21')
    expect(formatProgram(result.compiled.program)).toContain('app')
    expect(formatProgram(result.compiled.program)).not.toContain('splice')
    expect(result.compiled.log.join('\n')).not.toContain('splice')
  })

  it('specializes a cogen binding produced from code', () => {
    const result = execute('let cogen result = (let cogen u = code 1 in code u end) in result end')
    expect(formatValue(result.value)).toBe('1')
  })

  it('evaluates nested generated code to a generated-code closure', () => {
    const result = execute('let cogen u = code (code 1) in u end')
    expect(formatValue(result.value)).toBe("[() : emit('1)]")
  })

  it('evaluates lift inside generated code', () => {
    const result = execute('let cogen u = code (lift 1) in u end')
    expect(formatValue(result.value)).toBe('[1 : lift]')
  })

  it('evaluates application inside a generated function', () => {
    const result = execute('let cogen f = code (fn x => (fn y => y) x) in f 1 end')
    expect(formatValue(result.value)).toBe('1')
  })

  it('rejects eval because it is not an ML^box primitive', () => {
    expect(() => parse('eval (code 1)')).toThrow('Expected expression')
  })

  it('rejects multiplication because it is not an ML^box primitive', () => {
    expect(() => parse('1 * 2')).toThrow('Unexpected character: *')
  })

  it('formats compile traces from source term to final CCAM program', () => {
    const ast = parse('(fn x => x + 1) 41')
    const compiled = compile(ast)

    expect(compiled.log[0]).toBe('[[ (fn x => x + 1) 41 ]] Ω=∅')
    expectLinesInOrder(compiled.log, [
      'push; [[ fn x => x + 1 ]] Ω=∅; swap; [[ 41 ]] Ω=∅; cons; app',
      'push; Cur([[ x + 1 ]] Ω=x); swap; [[ 41 ]] Ω=∅; cons; app',
      'push; Cur(push; snd; swap; \'1; cons; add); swap; \'41; cons; app',
    ])
    expect(compiled.log.some((line) => line.includes('Cur(') && line.includes('[[ 41 ]] Ω=∅'))).toBe(true)
    expect(compiled.log).not.toContain('push')
    expect(compiled.log.at(-1)).toBe(formatProgram(compiled.program))
  })

  it('expands let cogen and lift compile traces one instruction at a time', () => {
    const ast = parse('let cogen result = (let cogen a = lift (6 + 7) in code (a + 8) end) in result end')
    const compiled = compile(ast)

    expectLinesInOrder(compiled.log, [
      'push; [[ let cogen a = lift (6 + 7) in code (a + 8) end ]] Ω=∅; cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; [[ lift (6 + 7) ]] Ω=∅; cons; [[ code (a + 8) ]] Ω=∅ Λ=a; cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; [[ 6 + 7 ]] Ω=∅; Cur(lift); cons; [[ code (a + 8) ]] Ω=∅ Λ=a; cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; push; [[ 6 ]] Ω=∅; swap; [[ 7 ]] Ω=∅; cons; add; Cur(lift); cons; [[ code (a + 8) ]] Ω=∅ Λ=a; cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; push; \'6; swap; [[ 7 ]] Ω=∅; cons; add; Cur(lift); cons; [[ code (a + 8) ]] Ω=∅ Λ=a; cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; push; \'6; swap; \'7; cons; add; Cur(lift); cons; [[ code (a + 8) ]] Ω=∅ Λ=a; cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; push; \'6; swap; \'7; cons; add; Cur(lift); cons; Cur([[ a + 8 ]] Ω=∅ Λ=a); cons; [[ result ]] Ω=∅ Λ=result',
    ])
    expectLinesInOrder(compiled.log, [
      'push; push; push; \'6; swap; \'7; cons; add; Cur(lift); cons; Cur(emit(push); [[ a ]] Ω=∅ Λ=a; emit(swap); [[ 8 ]] Ω=∅ Λ=a; emit(cons); emit(add)); cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; push; \'6; swap; \'7; cons; add; Cur(lift); cons; Cur(emit(push); push; fst; swap; push; fst; snd; swap; snd; cons; app; snd; cons; emit(swap); [[ 8 ]] Ω=∅ Λ=a; emit(cons); emit(add)); cons; [[ result ]] Ω=∅ Λ=result',
      'push; push; push; \'6; swap; \'7; cons; add; Cur(lift); cons; Cur(emit(push); push; fst; swap; push; fst; snd; swap; snd; cons; app; snd; cons; emit(swap); emit(\'8); emit(cons); emit(add)); cons; push; snd; swap; arena; cons; app; call',
    ])
    expect(compiled.log).not.toContain(
      'push; push; push; \'6; swap; \'7; cons; add; Cur(lift; snd); cons; Cur(emit(push); push; emit(swap); [[ 8 ]] Ω=∅ Λ=a; emit(cons); emit(add); snd); cons; snd; arena; cons; app; call',
    )
    expect(compiled.log.join('\n')).not.toContain('eval')
    expect(compiled.log).not.toContain('push')
    expect(compiled.log.at(-1)).toBe(formatProgram(compiled.program))
  })

  describe('Figure 3 CCAM transitions', () => {
    it('id leaves the stack unchanged', () => {
      expect(finalStack([{ op: 'id' }], intValue(1))).toBe('[1]')
    })

    it('fst projects the left side of a pair', () => {
      const result = run([{ op: 'fst' }], pairValue(intValue(1), intValue(2)))
      expect(formatValue(result.value)).toBe('1')
    })

    it('snd projects the right side of a pair', () => {
      const result = run([{ op: 'snd' }], pairValue(intValue(1), intValue(2)))
      expect(formatValue(result.value)).toBe('2')
    })

    it('quote replaces the top stack value with the quoted value', () => {
      const result = run([{ op: 'quote', value: intValue(2) }], intValue(1))
      expect(formatValue(result.value)).toBe('2')
    })

    it('push duplicates the top stack value', () => {
      expect(finalStack([{ op: 'push' }], intValue(1))).toBe('[1 :: 1]')
    })

    it('swap exchanges the top two stack values', () => {
      const program: Instruction[] = [{ op: 'push' }, { op: 'quote', value: intValue(2) }, { op: 'swap' }]
      expect(finalStack(program, intValue(1))).toBe('[1 :: 2]')
    })

    it('cons pairs the top two stack values', () => {
      const program: Instruction[] = [{ op: 'push' }, { op: 'quote', value: intValue(2) }, { op: 'cons' }]
      const result = run(program, intValue(1))
      expect(formatValue(result.value)).toBe('(1, 2)')
    })

    it('cur closes the current environment over a program', () => {
      const result = run([{ op: 'cur', program: [{ op: 'quote', value: intValue(2) }] }], intValue(1))
      expect(formatValue(result.value)).toBe("[1 : '2]")
    })

    it('app installs a closure environment and prepends its program', () => {
      const env = pairValue(closureValue(intValue(5), [{ op: 'snd' }]), intValue(9))
      const result = run([{ op: 'app' }], env)
      expect(formatValue(result.value)).toBe('9')
    })

    it('arena replaces the top stack value with a fresh empty code block', () => {
      expect(finalStack([{ op: 'arena' }], intValue(1))).toBe('[{.}]')
    })

    it('emit appends an instruction to the current code block', () => {
      const env = pairValue(intValue(1), blockValue())
      const result = run([{ op: 'emit', instruction: { op: 'quote', value: intValue(2) } }], env)
      expect(formatValue(result.value)).toBe("(1, {'2})")
    })

    it('lift appends a quote of the current value to the current code block', () => {
      const env = pairValue(intValue(7), blockValue())
      const result = run([{ op: 'lift' }], env)
      expect(formatValue(result.value)).toBe("(7, {'7})")
    })

    it('merge appends a Cur instruction to the current code block', () => {
      const env = pairValue(intValue(1), blockValue([{ op: 'quote', value: intValue(2) }]))
      const result = run([{ op: 'merge' }], pairValue(blockValue([{ op: 'snd' }]), env))
      expect(formatValue(result.value)).toBe("(1, {'2; Cur(snd)})")
    })

    it('call prepends the current code block to the instruction stream', () => {
      const result = run([{ op: 'call' }], pairValue(intValue(9), blockValue([{ op: 'id' }])))
      expect(formatValue(result.value)).toBe('9')
    })
  })

  describe('CCAM program parser', () => {
    it('round-trips a program containing every CCAM instruction form', () => {
      expectProgramRoundTrip([
        { op: 'id' },
        { op: 'fst' },
        { op: 'snd' },
        { op: 'push' },
        { op: 'swap' },
        { op: 'cons' },
        { op: 'app' },
        { op: 'quote', value: intValue(42) },
        { op: 'quote', value: { type: 'unit' } },
        { op: 'cur', program: [{ op: 'push' }, { op: 'snd' }] },
        { op: 'emit', instruction: { op: 'cur', program: [{ op: 'add' }] } },
        { op: 'lift' },
        { op: 'arena' },
        { op: 'merge' },
        { op: 'call' },
        { op: 'add' },
        { op: 'sub' },
      ])
    })

    it('round-trips each CCAM instruction as a single-instruction program', () => {
      const programs: Instruction[][] = [
        [{ op: 'id' }],
        [{ op: 'fst' }],
        [{ op: 'snd' }],
        [{ op: 'push' }],
        [{ op: 'swap' }],
        [{ op: 'cons' }],
        [{ op: 'app' }],
        [{ op: 'quote', value: intValue(1) }],
        [{ op: 'quote', value: { type: 'unit' } }],
        [{ op: 'cur', program: [{ op: 'id' }] }],
        [{ op: 'emit', instruction: { op: 'id' } }],
        [{ op: 'lift' }],
        [{ op: 'arena' }],
        [{ op: 'merge' }],
        [{ op: 'call' }],
        [{ op: 'add' }],
        [{ op: 'sub' }],
      ]

      for (const program of programs) {
        expectProgramRoundTrip(program)
      }
    })

    it('round-trips empty and nested CCAM programs', () => {
      expectProgramRoundTrip([])
      expectProgramRoundTrip([
        { op: 'cur', program: [{ op: 'cur', program: [{ op: 'emit', instruction: { op: 'quote', value: intValue(-3) } }] }] },
        { op: 'emit', instruction: { op: 'cur', program: [{ op: 'quote', value: { type: 'unit' } }] } },
        { op: 'merge' },
      ])
    })

    it('rejects unsupported CCAM program strings', () => {
      expect(() => parseProgram('unknown')).toThrow('Unknown CCAM instruction')
      expect(() => parseProgram('push; ; snd')).toThrow('Empty CCAM instruction')
      expect(() => parseProgram('merge(snd)')).toThrow('Unknown CCAM instruction')
      expect(() => parseProgram("'(1, 2)")).toThrow('Unsupported CCAM quoted value')
    })
  })

  describe('Figure 4 compilation rules', () => {
    it('compiles a value variable by selecting it from the environment', () => {
      const compiled = compileNormalTerm(parse('x'), [{ name: 'x', isCode: false }])
      expect(formatProgram(compiled.program)).toBe('snd')
    })

    it('compiles a lambda as a Cur instruction over the compiled body', () => {
      const compiled = compileNormalTerm(parse('fn x => x + 1'), [])
      expect(formatProgram(compiled.program)).toBe("Cur(push; snd; swap; '1; cons; add)")
    })

    it('compiles an application by evaluating function and argument before app', () => {
      const compiled = compileNormalTerm(parse('(fn x => x) 1'), [])
      expect(formatProgram(compiled.program)).toBe("push; Cur(snd); swap; '1; cons; app")
    })

    it('compiles a code variable by activating its generator in a fresh arena', () => {
      const compiled = compileNormalTerm(parse('u'), [{ name: 'u', isCode: true }])
      expect(formatProgram(compiled.program)).toBe('push; snd; swap; arena; cons; app; call')
    })

    it('compiles code as a Cur instruction around generator compilation', () => {
      const compiled = compileNormalTerm(parse('code 1'), [])
      expect(formatProgram(compiled.program)).toBe("Cur(emit('1))")
    })

    it('compiles lift by compiling the source term and wrapping lift in Cur', () => {
      const compiled = compileNormalTerm(parse('lift (1 + 2)'), [])
      expect(formatProgram(compiled.program)).toBe("push; '1; swap; '2; cons; add; Cur(lift)")
    })

    it('compiles let cogen by pairing the generated binding with the body environment', () => {
      const compiled = compileNormalTerm(parse('let cogen u = code 1 in 2 end'), [])
      expect(formatProgram(compiled.program)).toBe("push; Cur(emit('1)); cons; '2")
    })

    it('compiles generator value variables by emitting environment selections', () => {
      const compiled = compileGenerator(parse('x'), [{ name: 'x', isCode: false }], [])
      expect(formatProgram(compiled.program)).toBe('emit(snd)')
    })

    it('compiles generator lambdas by generating the body in a fresh arena before merge', () => {
      const compiled = compileGenerator(parse('fn x => x'), [], [])
      expect(formatProgram(compiled.program)).toBe('push; push; fst; swap; arena; cons; emit(snd); snd; swap; id; cons; merge')
    })

    it('compiles generator applications by emitting push, swap, cons, and app', () => {
      const compiled = compileGenerator(parse('(fn x => x) 1'), [], [])
      expect(formatProgram(compiled.program)).toBe(
        "emit(push); push; push; fst; swap; arena; cons; emit(snd); snd; swap; id; cons; merge; emit(swap); emit('1); emit(cons); emit(app)",
      )
    })

    it('compiles generator let cogen by binding the generated cogen before substituting it', () => {
      const compiled = compileGenerator(parse('let cogen u = code 1 in u end'), [], [])
      expect(formatProgram(compiled.program)).toBe(
        "emit(push); push; fst; Cur(emit('1)); swap; snd; cons; lift; emit(cons); emit(push); emit(snd); emit(swap); emit(arena); emit(cons); emit(app); emit(call)",
      )
    })

    it('compiles generator code variables in Lambda by substituting the captured generator', () => {
      const compiled = compileGenerator(parse('u'), [{ name: 'u', isCode: true }], ['u'])
      expect(formatProgram(compiled.program)).toBe('push; fst; swap; push; fst; snd; swap; snd; cons; app; snd; cons')
    })

    it('compiles nested generator code by lifting and applying a generator closure', () => {
      const compiled = compileGenerator(parse('code 1'), [], [])
      expect(formatProgram(compiled.program)).toBe(
        "push; fst; Cur(emit('1)); swap; snd; cons; lift",
      )
    })

    it('compiles generator lift by merging a fresh lifted body block', () => {
      const compiled = compileGenerator(parse('lift 1'), [], [])
      expect(formatProgram(compiled.program)).toBe("emit('1); push; push; fst; swap; arena; cons; emit(lift); snd; swap; id; cons; merge")
    })

    it('compiles generator let cogen by extending the generator environment', () => {
      const compiled = compileGenerator(parse('let cogen u = code 1 in 2 end'), [], [])
      expect(formatProgram(compiled.program)).toBe(
        "emit(push); push; fst; Cur(emit('1)); swap; snd; cons; lift; emit(cons); emit('2)",
      )
    })
  })
})
