import { Expr, Value, Environment } from './types';
import { Env } from './environment';
import * as readlineSync from 'readline-sync';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'url';

const execAsync = promisify(exec);
const fsPromises = fs.promises;

// ---------- Tensor helpers ----------
function inferShape(data: any[]): number[] {
  if (!Array.isArray(data)) return [];
  const shapes = data.map(item => inferShape(item));
  const first = shapes[0];
  if (shapes.some(s => JSON.stringify(s) !== JSON.stringify(first))) {
    throw new Error('Inconsistent tensor dimensions');
  }
  return [data.length, ...first];
}

function flattenTensor(data: any[]): number[] {
  const result: number[] = [];
  for (const item of data) {
    if (typeof item === 'number') {
      result.push(item);
    } else if (Array.isArray(item)) {
      result.push(...flattenTensor(item));
    } else {
      throw new Error('Tensor elements must be numbers or arrays');
    }
  }
  return result;
}

async function evaluateTensorLiteral(expr: { kind: 'tensor'; elements: Expr[] }, env: Environment): Promise<Value> {
  async function buildNested(elems: Expr[]): Promise<any[]> {
    const result: any[] = [];
    for (const e of elems) {
      if (e.kind === 'tensor') {
        const sub = await buildNested(e.elements);
        result.push(sub);
      } else {
        const val = await evaluateExpr(e, env);
        if (val.kind !== 'number') throw new Error('Tensor elements must be numbers');
        result.push(val.value);
      }
    }
    return result;
  }
  const nested = await buildNested(expr.elements);
  const shape = inferShape(nested);
  const data = flattenTensor(nested);
  return { kind: 'tensor', data, shape };
}

// ---------- Global HTTP state ----------
const routes: { method: string; path: string; handler: Value; isApi?: boolean }[] = [];
let staticDir: string | null = null;
let serverInstance: http.Server | null = null;
const apiDocs: { method: string; path: string }[] = [];

// ---------- Helper: parse route params ----------
function parseRouteParams(routePath: string, actualPath: string): Record<string, string> {
  const routeParts = routePath.split('/');
  const actualParts = actualPath.split('/');
  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i++) {
    if (routeParts[i].startsWith(':')) {
      const key = routeParts[i].slice(1);
      params[key] = actualParts[i] || '';
    }
  }
  return params;
}

// ---------- Helper: MIME types ----------
function getMimeType(ext: string): string {
  const mimes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain',
  };
  return mimes[ext] || 'application/octet-stream';
}

// ---------- AI helper (Python FFI) ----------
async function callPythonAI(action: string, code: string): Promise<string> {
  const script = `
import json
import sys

def ai_check(code):
    issues = []
    lines = code.split('\\n')
    depth = 0
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('function ') or stripped.startswith('if ') or stripped.startswith('while '):
            depth += 1
        if stripped == 'end':
            depth -= 1
        if depth < 0:
            issues.append("Unexpected 'end'")
            depth = 0
    if depth > 0:
        issues.append(f"Missing {depth} 'end' statement(s)")
    # Additional checks can be added
    return json.dumps(issues)

def ai_build(code):
    lines = code.split('\\n')
    new_lines = []
    depth = 0
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('function ') or stripped.startswith('if ') or stripped.startswith('while '):
            depth += 1
        if stripped == 'end':
            depth -= 1
        new_lines.append(line)
    while depth > 0:
        new_lines.append('end')
        depth -= 1
    return '\\n'.join(new_lines)

if __name__ == '__main__':
    action = sys.argv[1]
    code = sys.argv[2]
    if action == 'check':
        print(ai_check(code))
    elif action == 'build':
        print(ai_build(code))
  `;
  try {
    const { stdout, stderr } = await execAsync(`python3 -c "${script.replace(/"/g, '\\"')}" ${action} "${code.replace(/"/g, '\\"')}"`);
    if (stderr) throw new Error(stderr);
    return stdout.trim();
  } catch (err: any) {
    return `AI error: ${err.message}`;
  }
}

// ---------- Main evaluate ----------
export async function evaluate(exprs: Expr[], env: Environment = new Env()): Promise<Value> {
  const globalEnv = env as Env;
  // Built‑ins
  globalEnv.define('print', { kind: 'function', name: 'print', params: ['value'], body: [], env: globalEnv });
  globalEnv.define('input', { kind: 'function', name: 'input', params: [], body: [], env: globalEnv });
  globalEnv.define('matmul', { kind: 'function', name: 'matmul', params: ['a', 'b'], body: [], env: globalEnv });
  globalEnv.define('transpose', { kind: 'function', name: 'transpose', params: ['a'], body: [], env: globalEnv });
  globalEnv.define('reshape', { kind: 'function', name: 'reshape', params: ['a', 'shape'], body: [], env: globalEnv });
  globalEnv.define('relu', { kind: 'function', name: 'relu', params: ['a'], body: [], env: globalEnv });
  globalEnv.define('sigmoid', { kind: 'function', name: 'sigmoid', params: ['a'], body: [], env: globalEnv });
  globalEnv.define('delay', { kind: 'function', name: 'delay', params: ['ms'], body: [], env: globalEnv });
  globalEnv.define('readSensor', { kind: 'function', name: 'readSensor', params: ['pin'], body: [], env: globalEnv });
  globalEnv.define('setMotor', { kind: 'function', name: 'setMotor', params: ['pin', 'speed'], body: [], env: globalEnv });
  globalEnv.define('python', { kind: 'function', name: 'python', params: ['code'], body: [], env: globalEnv });
  globalEnv.define('spawn', { kind: 'function', name: 'spawn', params: ['fn'], body: [], env: globalEnv });
  globalEnv.define('await', { kind: 'function', name: 'await', params: ['future'], body: [], env: globalEnv });
  // HTTP
  globalEnv.define('route', { kind: 'function', name: 'route', params: ['method', 'path', 'handler'], body: [], env: globalEnv });
  globalEnv.define('startServer', { kind: 'function', name: 'startServer', params: ['port'], body: [], env: globalEnv });
  globalEnv.define('send', { kind: 'function', name: 'send', params: ['res', 'body'], body: [], env: globalEnv });
  globalEnv.define('json', { kind: 'function', name: 'json', params: ['res', 'obj'], body: [], env: globalEnv });
  globalEnv.define('setStatus', { kind: 'function', name: 'setStatus', params: ['res', 'code'], body: [], env: globalEnv });
  globalEnv.define('setHeader', { kind: 'function', name: 'setHeader', params: ['res', 'name', 'value'], body: [], env: globalEnv });
  globalEnv.define('getBody', { kind: 'function', name: 'getBody', params: ['req'], body: [], env: globalEnv });
  globalEnv.define('serveStatic', { kind: 'function', name: 'serveStatic', params: ['dir'], body: [], env: globalEnv });
  // API builder
  globalEnv.define('api_get', { kind: 'function', name: 'api_get', params: ['path', 'handler'], body: [], env: globalEnv });
  globalEnv.define('api_post', { kind: 'function', name: 'api_post', params: ['path', 'handler'], body: [], env: globalEnv });
  globalEnv.define('api_put', { kind: 'function', name: 'api_put', params: ['path', 'handler'], body: [], env: globalEnv });
  globalEnv.define('api_delete', { kind: 'function', name: 'api_delete', params: ['path', 'handler'], body: [], env: globalEnv });
  globalEnv.define('api_patch', { kind: 'function', name: 'api_patch', params: ['path', 'handler'], body: [], env: globalEnv });
  // AI
  globalEnv.define('ai_check', { kind: 'function', name: 'ai_check', params: ['code'], body: [], env: globalEnv });
  globalEnv.define('ai_build', { kind: 'function', name: 'ai_build', params: ['code'], body: [], env: globalEnv });

  let result: Value = { kind: 'null' };
  for (const expr of exprs) {
    result = await evaluateExpr(expr, env);
    if (result.kind === 'return') break;
  }
  return result;
}

// ---------- evaluateExpr ----------
async function evaluateExpr(expr: Expr, env: Environment): Promise<Value> {
  switch (expr.kind) {
    case 'number': return { kind: 'number', value: expr.value };
    case 'boolean': return { kind: 'boolean', value: expr.value };
    case 'string': return { kind: 'string', value: expr.value };
    case 'identifier': return env.get(expr.name);
    case 'binary': {
      const left = await evaluateExpr(expr.left, env);
      const right = await evaluateExpr(expr.right, env);
      return applyBinary(expr.op, left, right);
    }
    case 'unary': {
      const operand = await evaluateExpr(expr.operand, env);
      return applyUnary(expr.op, operand);
    }
    case 'call': {
      const callee = await evaluateExpr(expr.callee, env);
      if (callee.kind !== 'function') throw new Error('Can only call functions');
      const args = await Promise.all(expr.args.map(arg => evaluateExpr(arg, env)));
      return await callFunction(callee, args, env);
    }
    case 'if': {
      const cond = await evaluateExpr(expr.condition, env);
      if (isTruthy(cond)) {
        return evaluate(expr.then, env.extend());
      } else if (expr.else) {
        return evaluate(expr.else, env.extend());
      }
      return { kind: 'null' };
    }
    case 'while': {
      const whileEnv = env.extend();
      while (isTruthy(await evaluateExpr(expr.condition, whileEnv))) {
        await evaluate(expr.body, whileEnv);
      }
      return { kind: 'null' };
    }
    case 'block': {
      return evaluate(expr.body, env.extend());
    }
    case 'let': {
      const value = await evaluateExpr(expr.value, env);
      env.define(expr.name, value);
      return { kind: 'null' };
    }
    case 'assign': {
      const value = await evaluateExpr(expr.value, env);
      env.set(expr.name, value);
      return value;
    }
    case 'return': {
      const val = expr.value ? await evaluateExpr(expr.value, env) : { kind: 'null' };
      return { ...val, kind: 'return' as any };
    }
    case 'function': {
      const fn: Value = {
        kind: 'function',
        name: expr.name || '<anonymous>',
        params: expr.params,
        body: expr.body,
        env: env,
      };
      if (expr.name) env.define(expr.name, fn);
      return fn;
    }
    case 'tensor': {
      return await evaluateTensorLiteral(expr, env);
    }
    case 'import': {
      return { kind: 'null' };
    }
    default:
      throw new Error(`Unknown expression: ${(expr as any).kind}`);
  }
}

// ---------- applyBinary, applyUnary, isTruthy ----------
function applyBinary(op: string, left: Value, right: Value): Value {
  if (left.kind === 'number' && right.kind === 'number') {
    switch (op) {
      case '+': return { kind: 'number', value: left.value + right.value };
      case '-': return { kind: 'number', value: left.value - right.value };
      case '*': return { kind: 'number', value: left.value * right.value };
      case '/': return { kind: 'number', value: left.value / right.value };
      case '%': return { kind: 'number', value: left.value % right.value };
      case '<': return { kind: 'boolean', value: left.value < right.value };
      case '>': return { kind: 'boolean', value: left.value > right.value };
      case '<=': return { kind: 'boolean', value: left.value <= right.value };
      case '>=': return { kind: 'boolean', value: left.value >= right.value };
      case '==': return { kind: 'boolean', value: left.value === right.value };
      case '!=': return { kind: 'boolean', value: left.value !== right.value };
    }
  }
  if (op === '+' && left.kind === 'string' && right.kind === 'string') {
    return { kind: 'string', value: left.value + right.value };
  }
  if (op === '==' || op === '!=') {
    const eq = JSON.stringify(left) === JSON.stringify(right);
    return { kind: 'boolean', value: op === '==' ? eq : !eq };
  }
  if (op === '&&') {
    return { kind: 'boolean', value: isTruthy(left) && isTruthy(right) };
  }
  if (op === '||') {
    return { kind: 'boolean', value: isTruthy(left) || isTruthy(right) };
  }
  throw new Error(`Unsupported binary operator: ${op}`);
}

function applyUnary(op: string, operand: Value): Value {
  if (op === '-') {
    if (operand.kind !== 'number') throw new Error('Unary minus on non-number');
    return { kind: 'number', value: -operand.value };
  }
  if (op === '!') {
    return { kind: 'boolean', value: !isTruthy(operand) };
  }
  throw new Error(`Unsupported unary operator: ${op}`);
}

function isTruthy(val: Value): boolean {
  if (val.kind === 'null') return false;
  if (val.kind === 'boolean') return val.value;
  if (val.kind === 'number') return val.value !== 0;
  if (val.kind === 'string') return val.value.length > 0;
  return true;
}

// ---------- callFunction (all built‑ins) ----------
async function callFunction(fn: Value, args: Value[], env: Environment): Promise<Value> {
  if (fn.kind !== 'function') throw new Error('Not a function');

  // ---- print ----
  if (fn.name === 'print') {
    console.log(args.map(v => stringify(v)).join(' '));
    return { kind: 'null' };
  }
  // ---- input ----
  if (fn.name === 'input') {
    const answer = readlineSync.question('');
    return { kind: 'string', value: answer };
  }
  // ---- matmul ----
  if (fn.name === 'matmul') {
    if (args.length !== 2) throw new Error('matmul requires two arguments');
    const a = args[0], b = args[1];
    if (a.kind !== 'tensor' || b.kind !== 'tensor') throw new Error('Arguments must be tensors');
    const [rowsA, colsA] = a.shape;
    const [rowsB, colsB] = b.shape;
    if (colsA !== rowsB) throw new Error('Matrix dimensions mismatch');
    const dataA = a.data, dataB = b.data;
    const result: number[] = [];
    for (let i = 0; i < rowsA; i++) {
      for (let j = 0; j < colsB; j++) {
        let sum = 0;
        for (let k = 0; k < colsA; k++) {
          sum += dataA[i * colsA + k] * dataB[k * colsB + j];
        }
        result.push(sum);
      }
    }
    return { kind: 'tensor', data: result, shape: [rowsA, colsB] };
  }
  // ---- transpose ----
  if (fn.name === 'transpose') {
    if (args.length !== 1) throw new Error('transpose requires one argument');
    const a = args[0];
    if (a.kind !== 'tensor') throw new Error('Argument must be tensor');
    const [rows, cols] = a.shape;
    const data = a.data;
    const result: number[] = [];
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < rows; i++) {
        result.push(data[i * cols + j]);
      }
    }
    return { kind: 'tensor', data: result, shape: [cols, rows] };
  }
  // ---- reshape ----
  if (fn.name === 'reshape') {
    if (args.length !== 2) throw new Error('reshape requires tensor and new shape');
    const a = args[0];
    const shapeVal = args[1];
    if (a.kind !== 'tensor') throw new Error('First argument must be tensor');
    if (shapeVal.kind !== 'tensor' || shapeVal.shape.length !== 1) {
      throw new Error('Second argument must be a 1D tensor (shape)');
    }
    const newShape = shapeVal.data.map(n => Math.floor(n));
    const total = newShape.reduce((p, c) => p * c, 1);
    if (total !== a.data.length) throw new Error('Total elements mismatch');
    return { kind: 'tensor', data: a.data.slice(), shape: newShape };
  }
  // ---- relu ----
  if (fn.name === 'relu') {
    if (args.length !== 1) throw new Error('relu requires one tensor');
    const a = args[0];
    if (a.kind !== 'tensor') throw new Error('Argument must be tensor');
    const data = a.data.map(v => Math.max(0, v));
    return { kind: 'tensor', data, shape: a.shape.slice() };
  }
  // ---- sigmoid ----
  if (fn.name === 'sigmoid') {
    if (args.length !== 1) throw new Error('sigmoid requires one tensor');
    const a = args[0];
    if (a.kind !== 'tensor') throw new Error('Argument must be tensor');
    const data = a.data.map(v => 1 / (1 + Math.exp(-v)));
    return { kind: 'tensor', data, shape: a.shape.slice() };
  }
  // ---- delay ----
  if (fn.name === 'delay') {
    const ms = args[0]?.kind === 'number' ? args[0].value : 0;
    await new Promise(resolve => setTimeout(resolve, ms));
    return { kind: 'null' };
  }
  // ---- readSensor ----
  if (fn.name === 'readSensor') {
    const pin = args[0]?.kind === 'number' ? args[0].value : 0;
    return { kind: 'number', value: Math.random() * 100 };
  }
  // ---- setMotor ----
  if (fn.name === 'setMotor') {
    const pin = args[0]?.kind === 'number' ? args[0].value : 0;
    const speed = args[1]?.kind === 'number' ? args[1].value : 0;
    console.log(`Motor ${pin} set to speed ${speed}`);
    return { kind: 'null' };
  }
  // ---- python ----
  if (fn.name === 'python') {
    const code = args[0]?.kind === 'string' ? args[0].value : '';
    try {
      const { stdout, stderr } = await execAsync(`python3 -c "${code.replace(/"/g, '\\"')}"`);
      if (stderr) throw new Error(stderr);
      return { kind: 'string', value: stdout.trim() };
    } catch (err: any) {
      throw new Error(`Python error: ${err.message}`);
    }
  }
  // ---- spawn ----
  if (fn.name === 'spawn') {
    if (args.length !== 1) throw new Error('spawn requires a function');
    const fnVal = args[0];
    if (fnVal.kind !== 'function') throw new Error('Argument must be a function');
    const promise = (async () => {
      const newEnv = fnVal.env.extend();
      let result: Value = { kind: 'null' };
      for (const stmt of fnVal.body) {
        result = await evaluateExpr(stmt, newEnv);
        if (result.kind === 'return') break;
      }
      return result;
    })();
    return { kind: 'future', promise };
  }
  // ---- await ----
  if (fn.name === 'await') {
    if (args.length !== 1) throw new Error('await requires a future');
    const fut = args[0];
    if (fut.kind !== 'future') throw new Error('Argument must be a future');
    const result = await fut.promise;
    return result;
  }

  // ---- HTTP ----
  if (fn.name === 'route') {
    if (args.length !== 3) throw new Error('route requires method, path, handler');
    const method = (args[0].kind === 'string') ? args[0].value : '';
    const pathStr = (args[1].kind === 'string') ? args[1].value : '';
    const handler = args[2];
    if (handler.kind !== 'function') throw new Error('Handler must be a function');
    routes.push({ method, path: pathStr, handler });
    return { kind: 'null' };
  }

  if (fn.name === 'startServer') {
    if (args.length !== 1) throw new Error('startServer requires port');
    const port = (args[0].kind === 'number') ? args[0].value : 8080;
    if (serverInstance) serverInstance.close();
    serverInstance = http.createServer(async (req, res) => {
      const urlObj = parse(req.url || '', true);
      const method = req.method || 'GET';
      const pathname = urlObj.pathname || '/';
      // Try to match a route (exact or parameterized)
      let matchedRoute = null;
      let routeParams: Record<string, string> = {};
      for (const route of routes) {
        if (route.method === method && route.path === pathname) {
          matchedRoute = route;
          break;
        }
        const routeParts = route.path.split('/');
        const pathParts = pathname.split('/');
        if (routeParts.length === pathParts.length) {
          let match = true;
          const params: Record<string, string> = {};
          for (let i = 0; i < routeParts.length; i++) {
            if (routeParts[i].startsWith(':')) {
              params[routeParts[i].slice(1)] = pathParts[i];
            } else if (routeParts[i] !== pathParts[i]) {
              match = false;
              break;
            }
          }
          if (match) {
            matchedRoute = route;
            routeParams = params;
            break;
          }
        }
      }

      if (matchedRoute) {
        const handler = matchedRoute.handler;
        if (matchedRoute.isApi) {
          // API route: build ctx
          const ctx: any = {
            req,
            res,
            params: routeParams,
            query: urlObj.query,
            body: '',
            json: (obj: any) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(obj));
            },
          };
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const bodyStr = Buffer.concat(chunks).toString();
          ctx.body = bodyStr;
          try {
            if (req.headers['content-type']?.includes('application/json')) {
              ctx.body = JSON.parse(bodyStr);
            }
          } catch {}
          const handlerEnv = handler.env.extend();
          handlerEnv.define('ctx', { kind: 'object', value: ctx });
          for (const stmt of handler.body) {
            await evaluateExpr(stmt, handlerEnv);
          }
          return;
        } else {
          // Normal route: req and res as objects
          const reqObj: any = { method, path: pathname, query: urlObj.query, headers: req.headers, body: '' };
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          reqObj.body = Buffer.concat(chunks).toString();

          const resObj: any = {
            _statusCode: 200,
            _headers: {} as Record<string, string>,
            _ended: false,
            send: (body: any) => {
              if (resObj._ended) return;
              const str = typeof body === 'string' ? body : JSON.stringify(body);
              res.writeHead(resObj._statusCode, resObj._headers);
              res.end(str);
              resObj._ended = true;
            },
            json: (obj: any) => {
              if (resObj._ended) return;
              res.setHeader('Content-Type', 'application/json');
              resObj.send(JSON.stringify(obj));
            },
            status: (code: number) => {
              resObj._statusCode = code;
              return resObj;
            },
            setHeader: (name: string, value: string) => {
              resObj._headers[name] = value;
              return resObj;
            }
          };
          const reqVal: Value = { kind: 'object', value: reqObj };
          const resVal: Value = { kind: 'object', value: resObj };
          const handlerEnv = handler.env.extend();
          handlerEnv.define('req', reqVal);
          handlerEnv.define('res', resVal);
          for (const stmt of handler.body) {
            await evaluateExpr(stmt, handlerEnv);
          }
          if (!resObj._ended) {
            res.writeHead(200);
            res.end();
          }
          return;
        }
      }

      // Static file serving
      if (staticDir) {
        const filePath = path.join(staticDir, pathname);
        if (!filePath.startsWith(staticDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        try {
          const stats = await fsPromises.stat(filePath);
          if (stats.isDirectory()) {
            const indexPath = path.join(filePath, 'index.html');
            if (await fsPromises.access(indexPath).then(() => true).catch(() => false)) {
              const data = await fsPromises.readFile(indexPath);
              const ext = path.extname(indexPath);
              res.writeHead(200, { 'Content-Type': getMimeType(ext) });
              res.end(data);
              return;
            }
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const data = await fsPromises.readFile(filePath);
          const ext = path.extname(filePath);
          res.writeHead(200, { 'Content-Type': getMimeType(ext) });
          res.end(data);
          return;
        } catch (err) {}
      }

      // 404
      res.writeHead(404);
      res.end('Not Found');
    });
    serverInstance.listen(port, () => {
      console.log(`MOSLA server listening on port ${port}`);
    });
    return { kind: 'null' };
  }

  if (fn.name === 'send') {
    if (args.length !== 2) throw new Error('send requires res and body');
    const resVal = args[0];
    const body = args[1];
    if (resVal.kind !== 'object') throw new Error('First argument must be a response object');
    const resObj = resVal.value;
    if (typeof resObj.send !== 'function') throw new Error('Invalid response object');
    const bodyStr = (body.kind === 'string') ? body.value : stringify(body);
    resObj.send(bodyStr);
    return { kind: 'null' };
  }

  if (fn.name === 'json') {
    if (args.length !== 2) throw new Error('json requires res and obj');
    const resVal = args[0];
    const obj = args[1];
    if (resVal.kind !== 'object') throw new Error('First argument must be a response object');
    const resObj = resVal.value;
    if (typeof resObj.json !== 'function') throw new Error('Invalid response object');
    const jsObj = toJS(obj);
    resObj.json(jsObj);
    return { kind: 'null' };
  }

  if (fn.name === 'setStatus') {
    if (args.length !== 2) throw new Error('setStatus requires res and code');
    const resVal = args[0];
    const codeVal = args[1];
    if (resVal.kind !== 'object') throw new Error('First argument must be a response object');
    const resObj = resVal.value;
    if (typeof resObj.status !== 'function') throw new Error('Invalid response object');
    if (codeVal.kind !== 'number') throw new Error('Status code must be a number');
    resObj.status(codeVal.value);
    return { kind: 'null' };
  }

  if (fn.name === 'setHeader') {
    if (args.length !== 3) throw new Error('setHeader requires res, name, value');
    const resVal = args[0];
    const nameVal = args[1];
    const valueVal = args[2];
    if (resVal.kind !== 'object') throw new Error('First argument must be a response object');
    const resObj = resVal.value;
    if (typeof resObj.setHeader !== 'function') throw new Error('Invalid response object');
    if (nameVal.kind !== 'string') throw new Error('Header name must be a string');
    if (valueVal.kind !== 'string') throw new Error('Header value must be a string');
    resObj.setHeader(nameVal.value, valueVal.value);
    return { kind: 'null' };
  }

  if (fn.name === 'getBody') {
    if (args.length !== 1) throw new Error('getBody requires req');
    const reqVal = args[0];
    if (reqVal.kind !== 'object') throw new Error('Argument must be a request object');
    const reqObj = reqVal.value;
    if (typeof reqObj.body !== 'string') throw new Error('Invalid request object');
    return { kind: 'string', value: reqObj.body };
  }

  if (fn.name === 'serveStatic') {
    if (args.length !== 1) throw new Error('serveStatic requires a directory');
    const dirVal = args[0];
    if (dirVal.kind !== 'string') throw new Error('Directory must be a string');
    staticDir = path.join(process.cwd(), dirVal.value);
    console.log(`Serving static files from ${staticDir}`);
    return { kind: 'null' };
  }

  // ---- API builder ----
  const apiMethods = ['api_get', 'api_post', 'api_put', 'api_delete', 'api_patch'];
  if (apiMethods.includes(fn.name)) {
    if (args.length !== 2) throw new Error(`${fn.name} requires path and handler`);
    const pathStr = (args[0].kind === 'string') ? args[0].value : '';
    const handler = args[1];
    if (handler.kind !== 'function') throw new Error('Handler must be a function');
    const method = fn.name.replace('api_', '').toUpperCase();
    routes.push({
      method,
      path: pathStr,
      handler,
      isApi: true,
    });
    apiDocs.push({ method, path: pathStr });
    return { kind: 'null' };
  }

  // ---- AI built‑ins ----
  if (fn.name === 'ai_check') {
    if (args.length !== 1) throw new Error('ai_check requires a code string');
    const codeVal = args[0];
    if (codeVal.kind !== 'string') throw new Error('Code must be a string');
    const result = await callPythonAI('check', codeVal.value);
    return { kind: 'string', value: result };
  }

  if (fn.name === 'ai_build') {
    if (args.length !== 1) throw new Error('ai_build requires a code string');
    const codeVal = args[0];
    if (codeVal.kind !== 'string') throw new Error('Code must be a string');
    const result = await callPythonAI('build', codeVal.value);
    return { kind: 'string', value: result };
  }

  // ---- User‑defined function ----
  const newEnv = fn.env.extend();
  for (let i = 0; i < fn.params.length; i++) {
    newEnv.define(fn.params[i], args[i] || { kind: 'null' });
  }
  let result: Value = { kind: 'null' };
  for (const stmt of fn.body) {
    result = await evaluateExpr(stmt, newEnv);
    if (result.kind === 'return') {
      return { ...result, kind: result.kind };
    }
  }
  return result;
}

// ---------- Helpers ----------
function stringify(val: Value): string {
  switch (val.kind) {
    case 'null': return 'null';
    case 'number': return String(val.value);
    case 'boolean': return String(val.value);
    case 'string': return val.value;
    case 'function': return `<function ${val.name}>`;
    case 'tensor': return `tensor(${val.shape.join('x')}) [${val.data.join(', ')}]`;
    case 'future': return '<future>';
    case 'object': return '[object]';
    default: return 'unknown';
  }
}

function toJS(val: Value): any {
  switch (val.kind) {
    case 'number': return val.value;
    case 'boolean': return val.value;
    case 'string': return val.value;
    case 'null': return null;
    case 'tensor': return val.data;
    case 'object': return val.value;
    default: return undefined;
  }
}
