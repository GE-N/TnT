import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type CommandResult = { stdout: string; stderr: string };
export type Execute = (file: string, args: string[]) => Promise<CommandResult>;
export type Device = { id: string; name: string; runtime: string };

export type LaunchResult = {
  id: string; deviceId: string; deviceName: string; bundleId: string; startedAt: string;
  status: 'awaiting-confirmation' | 'confirmed' | 'failed'; log: string;
  screenshot?: string; error?: string; confirmedAt?: string;
};

export function createRunner(options: { artifactDirectory: string; execute: Execute; captureDelayMs?: number; ownershipDirectory?: string }) {
  const owned = new Set<string>();
  const runner = {
    async acquireDevice(id: string) {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Select a valid simulator identifier.');
      if (owned.size) throw new Error('A device operation is already in progress. Wait for cleanup before retrying.');
      owned.add(id);
      const base = options.ownershipDirectory ?? options.artifactDirectory;
      const path = join(base, 'device-ownership.lock');
      try {
        await mkdir(base, { recursive: true });
        const handle = await open(path, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, deviceId: id, acquiredAt: new Date().toISOString() })); }
        finally { await handle.close(); }
      } catch (error) {
        owned.delete(id);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A device operation is already in progress, or ownership survived a runner crash. Inspect .tnt/device-ownership.lock and stop its owned processes before recovery.');
        throw error;
      }
      return async () => { await unlink(path); owned.delete(id); };
    },
    async checkApp(deviceId: string, bundleId: string) {
      await options.execute('/usr/bin/xcrun', ['simctl', 'get_app_container', deviceId, bundleId, 'app']);
    },
    async devices(): Promise<Device[]> {
      const { stdout } = await options.execute('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
      const data = JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string; state: string; isAvailable: boolean }[]> };
      return Object.entries(data.devices).flatMap(([runtime, devices]) => devices
        .filter(device => device.state === 'Booted' && device.isAvailable)
        .map(device => ({ id: device.udid, name: device.name, runtime })));
    },
    async launch(input: { deviceId: string; bundleId: string }): Promise<LaunchResult> {
      if (typeof input.bundleId !== 'string' || input.bundleId.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(input.bundleId)) {
        throw new Error('Enter a valid bundle identifier, such as com.example.App.');
      }
      if (typeof input.deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.deviceId)) {
        throw new Error('Select a valid simulator identifier.');
      }
      const release = await runner.acquireDevice(input.deviceId);
      try {
      const device = (await runner.devices()).find(device => device.id === input.deviceId);
      if (!device) throw new Error('Select an available, already-running simulator and refresh the device list.');
      const id = randomUUID();
      const directory = join(options.artifactDirectory, id);
      await mkdir(directory, { recursive: true });
      const result: LaunchResult = {
        id, deviceId: device.id, deviceName: device.name, bundleId: input.bundleId,
        startedAt: new Date().toISOString(), status: 'awaiting-confirmation', log: '',
      };
      try {
        await options.execute('/usr/bin/xcrun', ['simctl', 'get_app_container', device.id, input.bundleId, 'app']);
        const launched = await options.execute('/usr/bin/xcrun', ['simctl', 'launch', device.id, input.bundleId]);
        result.log += launched.stdout + launched.stderr;
        await delay(options.captureDelayMs ?? 750);
        const captured = await options.execute('/usr/bin/xcrun', ['simctl', 'io', device.id, 'screenshot', join(directory, 'screen.png')]);
        result.log += '\n' + captured.stdout + captured.stderr;
        result.screenshot = '/api/launches/' + id + '/screen';
      } catch (error) {
        result.status = 'failed';
        result.error = error instanceof Error ? error.message : 'Launch failed.';
        result.log += '\n' + result.error;
      }
      await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
      return result;
      } finally { await release(); }
    },
    async result(id: string): Promise<LaunchResult> {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid launch identifier.');
      return JSON.parse(await readFile(join(options.artifactDirectory, id, 'result.json'), 'utf8')) as LaunchResult;
    },
    async confirm(id: string): Promise<LaunchResult> {
      const result = await runner.result(id);
      if (result.status !== 'awaiting-confirmation' || !result.screenshot) throw new Error('This launch has no screen awaiting confirmation.');
      result.status = 'confirmed';
      result.confirmedAt = new Date().toISOString();
      await writeFile(join(options.artifactDirectory, id, 'result.json'), JSON.stringify(result, null, 2));
      return result;
    },
  };
  return runner;
}
