import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../.tools/cobalt/api/', import.meta.url));
if (!existsSync(`${cwd}/node_modules`)) throw new Error('Instale o Cobalt conforme README.md.');
const child = spawn(process.execPath, ['src/cobalt.js'], {
  cwd, stdio: 'inherit',
  env: { ...process.env, API_URL: 'http://127.0.0.1:9000/', API_LISTEN_ADDRESS: '127.0.0.1', API_PORT: '9000' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
