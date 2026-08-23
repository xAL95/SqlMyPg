// Runs both workspace dev servers in parallel. The root script used to be
// `... --workspace=server & npm run dev --workspace=web`, but npm shells out to
// cmd.exe on Windows, where `&` is sequential, so vite never started and :5273
// refused connections.
import { spawn, spawnSync } from 'node:child_process';

const kids = ['server', 'web'].map((w) =>
  spawn('npm', ['run', 'dev', `--workspace=${w}`], { stdio: 'inherit', shell: true }),
);

// shell:true means each kid is a cmd.exe/sh wrapper, so kill() would leave the real
// tsx/vite process orphaned. Kill the tree instead: one dies, both die, rather than
// leaving a vite on :5273 proxying to a server that is gone.
const killTree = (k) =>
  process.platform === 'win32'
    ? spawnSync('taskkill', ['/pid', String(k.pid), '/T', '/F'], { stdio: 'ignore' })
    : k.kill();

let done = false;
const shutdown = (code) => {
  if (done) return;
  done = true;
  kids.forEach(killTree);
  process.exit(code ?? 1); // spawnSync above already reaped the trees
};

// Ctrl+C already reaches the children as a console-group signal; these cover an
// explicit kill. A hard TerminateProcess/SIGKILL of this parent still orphans them, and
// nothing in-process can catch that.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

for (const k of kids) {
  k.on('exit', shutdown);
}
