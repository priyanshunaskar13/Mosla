export function load(env: any) {
  env.define('io.print', {
    kind: 'function',
    name: 'print',
    params: ['value'],
    body: [],
    env,
  });
}
