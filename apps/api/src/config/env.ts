/** Fail fast at boot on missing/weak secrets instead of failing mysteriously later. */
export function validateEnv(env: Record<string, unknown>) {
  const errors: string[] = [];
  const need = (k: string) => {
    if (!env[k] || typeof env[k] !== 'string') errors.push(`${k} is required`);
  };
  ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'ENCRYPTION_KEY'].forEach(need);

  const secret = String(env.JWT_ACCESS_SECRET ?? '');
  if (secret && secret.length < 32) errors.push('JWT_ACCESS_SECRET must be at least 32 characters');
  if (env.ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(String(env.ENCRYPTION_KEY))) {
    errors.push('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  if (env.NODE_ENV === 'production') {
    if (/^0+$/.test(String(env.ENCRYPTION_KEY ?? ''))) errors.push('ENCRYPTION_KEY must not be the example value in production');
    if (/change-me/i.test(secret)) errors.push('JWT_ACCESS_SECRET must not be the example value in production');
  }
  if (errors.length) throw new Error(`Invalid environment:\n - ${errors.join('\n - ')}`);
  return env;
}
