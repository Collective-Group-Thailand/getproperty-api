// In-process MQTT 3.1.1 broker for the integration suite and `pnpm sim:gateway --broker` (aedes, ESM-only, so it
// runs in its own Node process). Prints `{"port":<n>}` once listening; stops on SIGTERM / SIGINT / stdin close.
import { createServer } from 'node:net';

import { Aedes } from 'aedes';

const port = Number(process.argv[2] ?? 0);
const broker = await Aedes.createBroker();
const server = createServer(broker.handle);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
const stop = () => {
  server.close();
  broker.close(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('close', stop);
process.stdin.resume();
