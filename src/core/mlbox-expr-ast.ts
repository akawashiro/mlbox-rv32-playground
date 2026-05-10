export type Expr =
  | { type: 'int'; value: number }
  | { type: 'var'; name: string }
  | { type: 'lambda'; param: string; body: Expr }
  | { type: 'app'; fn: Expr; arg: Expr }
  | { type: 'binary'; op: '+' | '-'; left: Expr; right: Expr }
  | { type: 'code'; body: Expr }
  | { type: 'lift'; body: Expr }
  | { type: 'letCogen'; name: string; generator: Expr; body: Expr }

export type ContextEntry = {
  name: string
  isCode: boolean
}
