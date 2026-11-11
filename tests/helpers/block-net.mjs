// Preload for tests only: no socket may connect. The thrown message deliberately contains
// the secret, to prove that error messages are never printed by the steps.
import net from 'node:net';

const secret = process.env.N1B_CONN ?? 'none';
net.Socket.prototype.connect = function () {
  if (process.env.N1B_TEST_CRASH === 'kill-on-connect') process.kill(process.pid, 'SIGKILL');
  throw Object.assign(new Error('blocked ' + secret), { code: 'EBLOCKED' });
};

if (process.env.N1B_TEST_CRASH === 'kill-early') process.kill(process.pid, 'SIGKILL');
if (process.env.N1B_TEST_CRASH === 'throw') {
  setTimeout(() => {
    throw new Error('crash ' + secret);
  }, 0);
}
if (process.env.N1B_TEST_CRASH === 'reject') {
  Promise.reject(new Error('reject ' + secret));
}
