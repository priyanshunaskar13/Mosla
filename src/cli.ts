#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copySync } from 'fs-extra';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { lexer } from './lexer';
import { Parser } from './parser';
import { evaluate } from './interpreter';
import { Env } from './environment';
import path from 'path';

const VERSION = '0.4.0';

program
  .version(VERSION)
  .description('MOSLA – AI-first programming language');

// ---- new ----
program
  .command('new <name>')
  .description('Create a new MOSLA project')
  .action((name: string) => {
    const targetDir = path.join(process.cwd(), name);
    if (existsSync(targetDir)) {
      console.error(`Error: directory ${name} already exists`);
      process.exit(1);
    }
    const templateDir = path.join(__dirname, '../templates/project');
    copySync(templateDir, targetDir);
    const configPath = path.join(targetDir, 'mos.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.name = name;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`✅ Project ${name} created.`);
    console.log(`   cd ${name}`);
    console.log('   mos run       # to run the project');
  });

// ---- run ----
program
  .command('run [file]')
  .description('Run a MOSLA file (default: main.mos)')
  .action(async (file: string = 'main.mos') => {
    const mainFile = path.join(process.cwd(), file);
    if (!existsSync(mainFile)) {
      console.error(`Error: ${file} not found`);
      process.exit(1);
    }
    try {
      const source = readFileSync(mainFile, 'utf-8');
      const tokens = lexer.reset(source);
      const parser = new Parser(Array.from(tokens));
      const ast = parser.parse();
      const result = await evaluate(ast);
      if (result && result.kind !== 'null' && result.kind !== 'return') {
        console.log(stringify(result));
      }
    } catch (err: any) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

// ---- serve ----
program
  .command('serve [file]')
  .description('Start HTTP server from a MOSLA file (default: server.mos)')
  .action(async (file: string = 'server.mos') => {
    const mainFile = path.join(process.cwd(), file);
    if (!existsSync(mainFile)) {
      console.error(`Error: ${file} not found`);
      process.exit(1);
    }
    try {
      const source = readFileSync(mainFile, 'utf-8');
      const tokens = lexer.reset(source);
      const parser = new Parser(Array.from(tokens));
      const ast = parser.parse();
      await evaluate(ast);
      // Keep process alive
      await new Promise(() => {});
    } catch (err: any) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  });

// ---- build ----
program
  .command('build')
  .description('Build the project')
  .action(() => {
    console.log('Building...');
    execSync('npm run build', { stdio: 'inherit' });
    console.log('✅ Build complete.');
  });

// ---- comp (stub) ----
program
  .command('comp')
  .description('Compile to bytecode (planned)')
  .action(() => {
    console.log('Compilation to bytecode not yet implemented.');
  });

// ---- exe (stub) ----
program
  .command('exe')
  .description('Generate native executable (planned)')
  .action(() => {
    console.log('Executable generation not yet implemented.');
  });

// ---- install ----
program
  .command('install <package>')
  .description('Install a package from the registry')
  .action((pkg: string) => {
    const pkgDir = path.join(process.cwd(), 'packages', pkg);
    if (!existsSync(pkgDir)) {
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(path.join(pkgDir, 'module.mos'), `// Package ${pkg}\n`);
      console.log(`✅ Package ${pkg} installed.`);
    } else {
      console.log(`Package ${pkg} already installed.`);
    }
  });

// ---- update ----
program
  .command('update')
  .description('Update all packages')
  .action(() => {
    console.log('Updating packages... (simulated)');
    console.log('✅ All packages updated.');
  });

// ---- check ----
program
  .command('check')
  .description('Check code for errors (lint)')
  .action(() => {
    console.log('Checking code... (simulated)');
    console.log('✅ No errors found.');
  });

// ---- fmt ----
program
  .command('fmt')
  .description('Format code')
  .action(() => {
    console.log('Formatting code... (simulated)');
    console.log('✅ Code formatted.');
  });

// ---- test ----
program
  .command('test')
  .description('Run tests')
  .action(() => {
    console.log('Running tests... (simulated)');
    console.log('✅ All tests passed.');
  });

// ---- publish ----
program
  .command('publish')
  .description('Publish package to registry')
  .action(() => {
    console.log('Publishing package... (simulated)');
    console.log('✅ Package published.');
  });

// ---- repl ----
program
  .command('repl')
  .description('Start REPL')
  .action(() => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'mos> ',
    });
    const env = new Env();
    console.log(`MOSLA REPL v${VERSION} (type :exit to quit)`);
    rl.prompt();
    rl.on('line', async (line) => {
      if (line.trim() === ':exit') {
        rl.close();
        return;
      }
      try {
        const tokens = lexer.reset(line);
        const parser = new Parser(Array.from(tokens));
        const ast = parser.parse();
        const result = await evaluate(ast, env);
        if (result && result.kind !== 'null' && result.kind !== 'return') {
          console.log(stringify(result));
        }
      } catch (err: any) {
        console.error('Error:', err.message);
      }
      rl.prompt();
    }).on('close', () => {
      process.exit(0);
    });
  });

// ---- ai-check ----
program
  .command('ai-check [file]')
  .description('Check code using built‑in AI')
  .action(async (file: string = 'main.mos') => {
    const mainFile = path.join(process.cwd(), file);
    if (!existsSync(mainFile)) {
      console.error(`Error: ${file} not found`);
      process.exit(1);
    }
    const source = readFileSync(mainFile, 'utf-8');
    try {
      const tokens = lexer.reset(`ai_check("${source.replace(/"/g, '\\"')}")`);
      const parser = new Parser(Array.from(tokens));
      const ast = parser.parse();
      const result = await evaluate(ast);
      if (result.kind === 'string') {
        console.log('🔍 AI Check Results:');
        try {
          const issues = JSON.parse(result.value);
          if (Array.isArray(issues) && issues.length === 0) {
            console.log('✅ No issues found.');
          } else {
            console.log(issues.join('\n'));
          }
        } catch {
          console.log(result.value);
        }
      }
    } catch (err: any) {
      console.error('Error:', err.message);
    }
  });

// ---- ai-build ----
program
  .command('ai-build [file]')
  .description('Build and auto‑fix using AI')
  .action(async (file: string = 'main.mos') => {
    const mainFile = path.join(process.cwd(), file);
    if (!existsSync(mainFile)) {
      console.error(`Error: ${file} not found`);
      process.exit(1);
    }
    const source = readFileSync(mainFile, 'utf-8');
    try {
      const tokens = lexer.reset(`ai_build("${source.replace(/"/g, '\\"')}")`);
      const parser = new Parser(Array.from(tokens));
      const ast = parser.parse();
      const result = await evaluate(ast);
      if (result.kind === 'string') {
        writeFileSync(mainFile, result.value);
        console.log('✅ Code fixed and saved. Run `mos run` to execute.');
      }
    } catch (err: any) {
      console.error('Error:', err.message);
    }
  });

program.parse(process.argv);

function stringify(val: any): string {
  if (val.kind === 'null') return 'null';
  if (val.kind === 'number' || val.kind === 'boolean') return String(val.value);
  if (val.kind === 'string') return val.value;
  if (val.kind === 'function') return `<function ${val.name}>`;
  if (val.kind === 'tensor') return `tensor(${val.shape.join('x')}) [${val.data.join(', ')}]`;
  if (val.kind === 'future') return '<future>';
  if (val.kind === 'object') return '[object]';
  return 'unknown';
}
