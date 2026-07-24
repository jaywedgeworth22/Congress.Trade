import { spawn } from 'child_process';
const dev = spawn('npm', ['run', 'dev'], { cwd: '/Users/jay/Code/Congress.Trade/app' });
dev.stdout.on('data', async (data) => {
  if (data.toString().includes('Ready on')) {
    console.log('Worker is ready, sending backfill request...');
    const res = await fetch('http://localhost:8787/api/admin/oge-backfill', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ***REMOVED***' }
    });
    console.log(await res.text());
    dev.kill();
  }
});
