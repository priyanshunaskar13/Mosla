export function load(env: any) {
  env.define('ai.load', {
    kind: 'function',
    name: 'load',
    params: ['modelName'],
    body: [],
    env,
  });
}
