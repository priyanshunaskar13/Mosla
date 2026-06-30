import { Token } from './lexer';
import { Expr } from './types';

export class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens.filter(t => t.type !== 'whitespace' && t.type !== 'comment');
  }

  private peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  private next(): Token {
    if (this.pos >= this.tokens.length) throw new Error('Unexpected end of input');
    return this.tokens[this.pos++];
  }

  private expect(type: string): Token {
    const tok = this.next();
    if (tok.type !== type) throw new Error(`Expected ${type}, got ${tok.type}`);
    return tok;
  }

  private match(type: string): boolean {
    const tok = this.peek();
    if (tok && tok.type === type) {
      this.next();
      return true;
    }
    return false;
  }

  parse(): Expr[] {
    const program: Expr[] = [];
    while (this.peek()) {
      program.push(this.parseStatement());
    }
    return program;
  }

  private parseStatement(): Expr {
    const tok = this.peek();
    if (!tok) throw new Error('Unexpected EOF');
    switch (tok.value) {
      case 'import': return this.parseImport();
      case 'let': return this.parseLet();
      case 'if': return this.parseIf();
      case 'while': return this.parseWhile();
      case 'return': return this.parseReturn();
      case 'function': return this.parseFunctionDef();
      case 'end': throw new Error('Unexpected "end"');
      default: return this.parseExpression();
    }
  }

  private parseImport(): Expr {
    this.next(); // 'import'
    const pathParts: string[] = [];
    while (true) {
      const id = this.expect('identifier').value as string;
      pathParts.push(id);
      if (this.peek()?.value !== '.') break;
      this.next(); // consume '.'
    }
    if (this.peek()?.type === 'punctuation' && this.peek()?.value === ';') {
      this.next();
    }
    return { kind: 'import', path: pathParts.join('.') };
  }

  private parseLet(): Expr {
    this.next(); // 'let'
    const name = this.expect('identifier').value as string;
    this.expect('operator'); // '='
    const value = this.parseExpression();
    if (this.peek()?.type === 'punctuation' && this.peek()?.value === ';') {
      this.next();
    }
    return { kind: 'let', name, value };
  }

  private parseIf(): Expr {
    this.next(); // 'if'
    this.expect('punctuation'); // '('
    const condition = this.parseExpression();
    this.expect('punctuation'); // ')'
    const thenBody: Expr[] = [];
    while (this.peek() && this.peek()!.value !== 'else' && this.peek()!.value !== 'end') {
      thenBody.push(this.parseStatement());
    }
    let elseBody: Expr[] | null = null;
    if (this.peek()?.value === 'else') {
      this.next(); // 'else'
      elseBody = [];
      while (this.peek() && this.peek()!.value !== 'end') {
        elseBody.push(this.parseStatement());
      }
    }
    this.expect('identifier'); // 'end'
    return { kind: 'if', condition, then: thenBody, else: elseBody };
  }

  private parseWhile(): Expr {
    this.next(); // 'while'
    this.expect('punctuation'); // '('
    const condition = this.parseExpression();
    this.expect('punctuation'); // ')'
    const body: Expr[] = [];
    while (this.peek() && this.peek()!.value !== 'end') {
      body.push(this.parseStatement());
    }
    this.expect('identifier'); // 'end'
    return { kind: 'while', condition, body };
  }

  private parseReturn(): Expr {
    this.next(); // 'return'
    let value: Expr | null = null;
    if (this.peek() && this.peek()!.type !== 'punctuation' && this.peek()!.value !== 'end') {
      value = this.parseExpression();
    }
    if (this.peek()?.type === 'punctuation' && this.peek()?.value === ';') {
      this.next();
    }
    return { kind: 'return', value };
  }

  private parseFunctionDef(): Expr {
    this.next(); // 'function'
    const name = this.expect('identifier').value as string;
    this.expect('punctuation'); // '('
    const params: string[] = [];
    if (this.peek()?.value !== ')') {
      do {
        params.push(this.expect('identifier').value as string);
      } while (this.match('punctuation') && this.peek()?.value === ',');
    }
    this.expect('punctuation'); // ')'
    const body: Expr[] = [];
    while (this.peek() && this.peek()!.value !== 'end') {
      body.push(this.parseStatement());
    }
    this.expect('identifier'); // 'end'
    return { kind: 'function', name, params, body };
  }

  private parseExpression(): Expr {
    return this.parseAssignment();
  }

  private parseAssignment(): Expr {
    let left = this.parseLogicalOr();
    if (this.match('operator') && this.peek()?.value === '=') {
      this.next(); // consume '='
      const right = this.parseExpression();
      if (left.kind === 'identifier') {
        return { kind: 'assign', name: left.name, value: right };
      }
      throw new Error('Invalid left-hand side in assignment');
    }
    return left;
  }

  private parseLogicalOr(): Expr {
    let left = this.parseLogicalAnd();
    while (this.peek()?.value === '||') {
      this.next();
      const right = this.parseLogicalAnd();
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  private parseLogicalAnd(): Expr {
    let left = this.parseEquality();
    while (this.peek()?.value === '&&') {
      this.next();
      const right = this.parseEquality();
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseComparison();
    while (this.peek()?.value === '==' || this.peek()?.value === '!=') {
      const op = this.next().value as string;
      const right = this.parseComparison();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    while (this.peek()?.value === '<' || this.peek()?.value === '>' ||
           this.peek()?.value === '<=' || this.peek()?.value === '>=') {
      const op = this.next().value as string;
      const right = this.parseAdditive();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek()?.value === '+' || this.peek()?.value === '-') {
      const op = this.next().value as string;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.peek()?.value === '*' || this.peek()?.value === '/' ||
           this.peek()?.value === '%') {
      const op = this.next().value as string;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek()?.value === '-' || this.peek()?.value === '!') {
      const op = this.next().value as string;
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parseCall();
  }

  private parseCall(): Expr {
    let expr = this.parsePrimary();
    while (this.peek()?.type === 'punctuation' && this.peek()?.value === '(') {
      this.next(); // '('
      const args: Expr[] = [];
      if (this.peek()?.value !== ')') {
        do {
          args.push(this.parseExpression());
        } while (this.match('punctuation') && this.peek()?.value === ',');
      }
      this.expect('punctuation'); // ')'
      expr = { kind: 'call', callee: expr, args };
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const tok = this.next();
    switch (tok.type) {
      case 'number':
        return { kind: 'number', value: parseFloat(tok.value as string) };
      case 'boolean':
        return { kind: 'boolean', value: tok.value === 'true' };
      case 'string':
        return { kind: 'string', value: (tok.value as string).slice(1, -1) };
      case 'identifier':
        return { kind: 'identifier', name: tok.value as string };
      case 'punctuation':
        if (tok.value === '(') {
          const expr = this.parseExpression();
          this.expect('punctuation'); // ')'
          return expr;
        }
        if (tok.value === '[') {
          const elements: Expr[] = [];
          if (this.peek()?.value !== ']') {
            do {
              elements.push(this.parseExpression());
            } while (this.match('punctuation') && this.peek()?.value === ',');
          }
          this.expect('punctuation'); // ']'
          return { kind: 'tensor', elements };
        }
        throw new Error(`Unexpected punctuation: ${tok.value}`);
      default:
        throw new Error(`Unexpected token type: ${tok.type}`);
    }
  }
}
