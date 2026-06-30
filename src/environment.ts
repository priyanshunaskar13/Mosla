import { Environment, Value } from './types';

export class Env implements Environment {
  private store: Map<string, Value>;
  private parent: Environment | null;

  constructor(parent: Environment | null = null) {
    this.store = new Map();
    this.parent = parent;
  }

  get(name: string): Value {
    if (this.store.has(name)) return this.store.get(name)!;
    if (this.parent) return this.parent.get(name);
    throw new Error(`Undefined variable: ${name}`);
  }

  set(name: string, value: Value): void {
    if (this.store.has(name)) {
      this.store.set(name, value);
      return;
    }
    if (this.parent) {
      this.parent.set(name, value);
      return;
    }
    throw new Error(`Cannot assign to undefined variable: ${name}`);
  }

  define(name: string, value: Value): void {
    if (this.store.has(name)) {
      throw new Error(`Variable already defined: ${name}`);
    }
    this.store.set(name, value);
  }

  extend(): Environment {
    return new Env(this);
  }
}
