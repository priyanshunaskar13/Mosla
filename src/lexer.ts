import moo from 'moo';

export const lexer = moo.compile({
  number: /[0-9]+(\.[0-9]+)?/,
  string: /"(?:\\["\\]|[^"\\])*"/,
  boolean: /true|false/,
  identifier: /[a-zA-Z_][a-zA-Z0-9_]*/,
  whitespace: { match: /\s+/, lineBreaks: true },
  comment: { match: /\/\/.*/, lineBreaks: true },
  operator: /[+\-*/%=]=?|!=|<=|>=|&&|\|\|/,
  punctuation: /[{}()\[\],;]/,
  newline: { match: /\n/, lineBreaks: true },
});

export type Token = moo.Token;
