const hooks: (() => Promise<void>)[] = [];

/** Runs on SIGINT, SIGTERM, and SIGHUP before the workspace lock is released. */
export function onServerShutdown(hook: () => Promise<void>) {
  hooks.push(hook);
}

export async function runShutdownHooks() {
  const pending = hooks.map(hook => Promise.resolve().then(hook));
  await Promise.all(pending.map(work => work.catch(() => undefined)));
}
