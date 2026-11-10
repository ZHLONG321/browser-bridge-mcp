// Hidden launchers inspect capabilities without embedding programs in a shell.
try {
  await import('ws');
  process.exitCode = typeof fetch === 'function' && typeof AbortSignal.timeout === 'function' ? 0 : 1;
} catch {process.exitCode = 1;}
