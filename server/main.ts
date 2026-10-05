import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createRunner, type Execute } from './runner.js';
import { createApiHandler } from './http.js';
import { createScenarios } from './scenarios.js';
import { createMaestro } from './maestro.js';

const exec = promisify(execFile);
const execute: Execute = async (file, args) => {
  try { return await exec(file, args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean };
    if (failure.code === 'ENOENT') throw new Error('Xcode command-line tools are missing. Install/select Xcode and refresh.');
    if (failure.killed) throw new Error('Simulator command timed out after 30 seconds. Check the simulator and try again.');
    const hint = args.includes('get_app_container') ? 'App is not installed on the selected simulator. Check its bundle ID. ' : '';
    throw new Error(hint + (failure.stderr || failure.stdout || failure.message).slice(-12_000));
  }
};
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
const artifactDirectory = resolve('.tnt/launches');
const maestro = createMaestro();
const runner = createRunner({ artifactDirectory, execute, ownershipDirectory: resolve('.tnt'), inspector: maestro });
const scenarios = createScenarios({ root: resolve('.tnt'), runner, maestro });
const production = process.argv.includes('--production');
const server = createServer();
let serve: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void;

if (production) {
  const dist = resolve('dist');
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  serve = async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const file = resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end('Not found. Run npm run build before npm start.'); }
  };
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  serve = (request, response) => vite.middlewares(request, response);
}
server.on('request', createApiHandler(runner, artifactDirectory, serve, scenarios));
server.on('error', error => { console.error('Unable to start workbench:', error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`TnT workbench: http://127.0.0.1:${port} (${production ? 'production' : 'development'})`));
