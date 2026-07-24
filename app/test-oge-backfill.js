import { spawn } from 'child_process';
const dev = spawn('npm', ['run', 'dev'], { cwd: '/Users/jay/Code/Congress.Trade/app' });
dev.stdout.on('data', async (data) => {
  if (data.toString().includes('Ready on')) {
    console.log('Worker is ready, sending backfill request...');
    const res = await fetch('http://localhost:8787/api/admin/oge-backfill', {
      method: 'POST',
      headers: { 'authorization': 'Bearer 56c11f2e0c7fa4d019d379fd0b8676199ad1186ad8b09fe5be6a7b2ecbf05060' }
    });
    console.log(await res.text());
    dev.kill();
  }
});
