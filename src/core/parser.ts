import type { Expr } from './ast'

type Token =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'symbol'; value: string }
  | { type: 'keyword'; value: string }
  | { type: 'eof' }

const keywords = new Set(['fn', 'code', 'lift', 'let', 'cogen', 'in', 'end', 'eval'])

export function parse(input: string): Expr {
  const parser = new Parser(tokenize(input))
  const expr = parser.parseExpr()
  parser.expect('eof')
  return expr
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < input.length) {
    const rest = input.slice(index)
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) {
      index += whitespace[0].length
      continue
    }

    const number = /^\d+/.exec(rest)
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]) })
      index += number[0].length
      continue
    }

    const arrow = /^=>/.exec(rest)
    if (arrow) {
      tokens.push({ type: 'symbol', value: '=>' })
      index += 2
      continue
    }

    const lambda = /^\\/.exec(rest)
    if (lambda) {
      tokens.push({ type: 'keyword', value: 'fn' })
      index += 1
      continue
    }

    const ident = /^[A-Za-z_][A-Za-z0-9_']*/.exec(rest)
    if (ident) {
      const value = ident[0]
      tokens.push(keywords.has(value) ? { type: 'keyword', value } : { type: 'ident', value })
      index += value.length
      continue
    }

    const symbol = /^[().=+-]/.exec(rest)
    if (symbol) {
      tokens.push({ type: 'symbol', value: symbol[0] })
      index += 1
      continue
    }

    throw new Error(`Unexpected character: ${input[index]}`)
  }

  tokens.push({ type: 'eof' })
  return tokens
}

class Parser {
  private index = 0
  private readonly tokens: Token[]

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  parseExpr(): Expr {
    return this.parseLet()
  }

  private parseLet(): Expr {
    if (this.matchKeyword('let')) {
      this.expectKeyword('cogen')
      const name = this.expectIdent()
      this.expectSymbol('=')
      const generator = this.parseExpr()
      this.expectKeyword('in')
      const body = this.parseExpr()
      this.expectKeyword('end')
      return { type: 'letCogen', name, generator, body }
    }
    return this.parseLambda()
  }

  private parseLambda(): Expr {
    if (this.matchKeyword('fn')) {
      const param = this.expectIdent()
      if (!this.matchSymbol('=>')) {
        this.expectSymbol('.')
      }
      return { type: 'lambda', param, body: this.parseExpr() }
    }
    return this.parseBinary(0)
  }

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseApplication()
    let token = this.peek()
    while (this.isOperator(token)) {
      const op = token.value
      const precedence = 1
      if (precedence < minPrecedence) break
      this.index += 1
      const right = this.parseBinary(precedence + 1)
      left = { type: 'binary', op, left, right }
      token = this.peek()
    }
    return left
  }

  private parseApplication(): Expr {
    let expr = this.parseAtom()
    while (this.startsAtom(this.peek())) {
      expr = { type: 'app', fn: expr, arg: this.parseAtom() }
    }
    return expr
  }

  private parseAtom(): Expr {
    const token = this.peek()
    if (token.type === 'number') {
      this.index += 1
      return { type: 'int', value: token.value }
    }
    if (token.type === 'ident') {
      this.index += 1
      return { type: 'var', name: token.value }
    }
    if (this.matchKeyword('code')) return { type: 'code', body: this.parseAtom() }
    if (this.matchKeyword('lift')) return { type: 'lift', body: this.parseAtom() }
    if (this.matchSymbol('(')) {
      const expr = this.parseExpr()
      this.expectSymbol(')')
      return expr
    }
    throw new Error(`Expected expression, got ${this.describe(token)}`)
  }

  private startsAtom(token: Token): boolean {
    return (
      token.type === 'number' ||
      token.type === 'ident' ||
      (token.type === 'keyword' && ['code', 'lift'].includes(token.value)) ||
      (token.type === 'symbol' && token.value === '(')
    )
  }

  private isOperator(token: Token): token is { type: 'symbol'; value: '+' | '-' } {
    return token.type === 'symbol' && (token.value === '+' || token.value === '-')
  }

  private peek(): Token {
    return this.tokens[this.index]
  }

  private matchKeyword(value: string): boolean {
    const token = this.peek()
    if (token.type === 'keyword' && token.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  private expectKeyword(value: string): void {
    if (!this.matchKeyword(value)) throw new Error(`Expected keyword ${value}`)
  }

  private matchSymbol(value: string): boolean {
    const token = this.peek()
    if (token.type === 'symbol' && token.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  private expectSymbol(value: string): void {
    if (!this.matchSymbol(value)) throw new Error(`Expected symbol ${value}`)
  }

  private expectIdent(): string {
    const token = this.peek()
    if (token.type !== 'ident') throw new Error(`Expected identifier, got ${this.describe(token)}`)
    this.index += 1
    return token.value
  }

  expect(type: Token['type']): void {
    if (this.peek().type !== type) throw new Error(`Expected ${type}, got ${this.describe(this.peek())}`)
  }

  private describe(token: Token): string {
    if ('value' in token) return `${token.type} ${token.value}`
    return token.type
  }
}
