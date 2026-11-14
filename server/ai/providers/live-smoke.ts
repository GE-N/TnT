/** True only when the opt-in smoke key is present. npm test never sets it, and this does not read a keychain. */
export function liveSmokeEnabled(env: NodeJS.ProcessEnv) {
  const key = env.TNT_PROVIDER_SMOKE_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}
