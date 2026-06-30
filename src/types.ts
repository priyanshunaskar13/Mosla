export type Value =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'null' }
  | { kind: 'function'; name: string; params: string[]; body: Expr[]; env: Environment }
  | { kind: 'tensor'; data: number[]; shape: number[] }
  | { kind: 'future'; promise: Promise<Value> }
  | { kind: 'object'; value: any };

export type Environment = {
  get(name: string): Value;
  set(name: string, value: Value): void;
  define(name: string, value: Value): void;
  extend(): Environment;
};

export type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'unary'; op: string; operand: Expr }
  | { kind: 'call'; callee: Expr; args: Expr[] }
  | { kind: 'if'; condition: Expr; then: Expr[]; else: Expr[] | null }
  | { kind: 'while'; condition: Expr; body: Expr[] }
  | { kind: 'block'; body: Expr[] }
  | { kind: 'let'; name: string; value: Expr }
  | { kind: 'assign'; name: string; value: Expr }
  | { kind: 'return'; value: Expr | null }
  | { kind: 'function'; name: string | null; params: string[]; body: Expr[] }
  | { kind: 'tensor'; elements: Expr[] }
  | { kind: 'import'; path: string };
