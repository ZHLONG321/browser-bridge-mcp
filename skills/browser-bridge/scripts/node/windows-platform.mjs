// Shared by isolated MCP/CLI calls, direct Node functions and guarded browser helpers.
export function requireWindows() {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('Windows commands are unavailable on this platform.'), {
      code: 'WINDOWS_UNAVAILABLE', details: {platform: process.platform},
    });
  }
}
