import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

export interface TestBroker {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * Starts the aedes broker (`test/support/mqtt-broker.mjs`) in a child process — a real MQTT 3.1.1 broker without
 * Docker (the platform runs EMQX with MQTT 5 shared subscriptions; the suite sets `MQTT_PROTOCOL_VERSION=4` and
 * `MQTT_SHARED_SUBSCRIPTION=false`, D-185).
 */
export async function startTestBroker(): Promise<TestBroker> {
  const child: ChildProcess = spawn(process.execPath, [join(__dirname, 'mqtt-broker.mjs')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('mqtt broker did not start')), 15_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const line = buffer.split('\n')[0];
      if (line && buffer.includes('\n')) {
        clearTimeout(timer);
        resolve((JSON.parse(line) as { port: number }).port);
      }
    });
    child.once('exit', (code) => reject(new Error(`mqtt broker exited (${code})`)));
  });
  return {
    port,
    url: `mqtt://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
