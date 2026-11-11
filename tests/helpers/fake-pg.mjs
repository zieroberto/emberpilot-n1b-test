// Loopback-only fake Postgres server for offline protocol evidence. Never leaves 127.0.0.1.
import net from 'node:net';
import tls from 'node:tls';

const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const msg = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);
};

export function authOk() {
  return msg('R', i32(0));
}
export function ready() {
  return msg('Z', Buffer.from('I'));
}
export function authSasl(mechs) {
  return msg('R', i32(10), Buffer.from(mechs.map((m) => m + '\0').join('') + '\0'));
}
export function authMd5() {
  return msg('R', i32(5), Buffer.from([1, 2, 3, 4]));
}
export function authCleartext() {
  return msg('R', i32(3));
}
export function errorResponse(code, text) {
  const field = (k, v) => Buffer.concat([Buffer.from(k), Buffer.from(v + '\0')]);
  return msg('E', field('S', 'FATAL'), field('V', 'FATAL'), field('C', code), field('M', text), Buffer.from('\0'));
}

// mode: 'trust' | 'sasl' | 'sasl-plus' | 'md5' | 'cleartext' | 'auth-error'
// ignoreTerminate: when true the server never closes the connection after the client's Terminate,
// and keeps its side half-open after the client's FIN, so a client that does not destroy its socket
// keeps it open.
export async function startFakePg({ mode = 'trust', tlsOptions = null, ignoreTerminate = false } = {}) {
  const log = [];
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: ignoreTerminate }, (socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let phase = 'init';
    let active = socket;
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (phase === 'init') {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          const body = buf.subarray(8, len);
          buf = buf.subarray(len);
          if (code === 80877103) {
            log.push({ t: 'ssl-request' });
            if (tlsOptions) {
              active.write('S');
              const secure = new tls.TLSSocket(socket, { isServer: true, ...tlsOptions });
              secure.on('error', () => {});
              secure.on('data', onData);
              active = secure;
            } else {
              active.write('N');
            }
            continue;
          }
          if (code === 196608) {
            const items = body.toString('utf8').split('\0');
            const params = {};
            for (let i = 0; i + 1 < items.length; i += 2) if (items[i]) params[items[i]] = items[i + 1];
            log.push({ t: 'startup', params });
            phase = 'main';
            if (mode === 'trust') active.write(Buffer.concat([authOk(), ready()]));
            else if (mode === 'sasl') active.write(authSasl(['SCRAM-SHA-256']));
            else if (mode === 'sasl-plus') active.write(authSasl(['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256']));
            else if (mode === 'md5') active.write(authMd5());
            else if (mode === 'cleartext') active.write(authCleartext());
            else if (mode === 'auth-error') active.write(errorResponse('28P01', 'password authentication failed'));
            continue;
          }
          log.push({ t: 'unknown-init', code });
          active.destroy();
          return;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        buf = buf.subarray(len + 1);
        log.push({ t: 'msg', type });
        if (type === 'X') {
          if (!ignoreTerminate) active.end();
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      log.push({ t: 'close' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    log,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
