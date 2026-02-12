#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, '..', 'src', 'cli.ts');
const tsx = join(__dirname, '..', 'node_modules', '.bin', 'tsx');

const child = spawn(tsx, [cli], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
