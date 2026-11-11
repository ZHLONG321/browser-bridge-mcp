import {readFile} from 'node:fs/promises';
import {operations, windows_call} from './windows-runner.mjs';

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'windows') argv.shift(); // BAT forwards its complete argument list.
  const operation = argv.shift()?.replaceAll('-', '_');
  if (!operation || ['help', '_help'].includes(operation)) {
    console.log('Usage: browser-bridge.bat windows OPERATION [--field VALUE] [--json REQUEST.json]\n' + operations.join('\n'));
    return;
  }
  if (!operations.includes(operation)) throw new TypeError('Unknown Windows operation. Use windows help.');
  let args = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!/^--[a-z][a-z_-]*$/.test(flag) || i + 1 >= argv.length) throw new TypeError('Each --field requires a value.');
    const name = flag.slice(2).replaceAll('-', '_');
    if (seen.has(name)) throw new TypeError('Duplicate command parameter.');
    seen.add(name);
    if (name === 'json') {
      const object = JSON.parse(await readFile(argv[i + 1], 'utf8'));
      if (!object || Array.isArray(object) || typeof object !== 'object') throw new TypeError('Request file must contain a flat options object.');
      for (const key of Object.keys(object)) if (Object.hasOwn(args, key)) throw new TypeError('Duplicate command parameter.');
      args = {...args, ...object};
    } else {
      if (Object.hasOwn(args, name)) throw new TypeError('Duplicate command parameter.');
      const input = argv[i + 1];
      let value = input;
      try { value = JSON.parse(input); } catch { /* Ordinary unquoted strings are accepted. */ }
      Object.defineProperty(args, name, {value, enumerable: true, configurable: true, writable: true});
    }
  }
  const value = await windows_call(operation, args);
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
}

main().catch(error => {
  console.error(JSON.stringify({error: {code: error.code || 'WINDOWS_COMMAND_FAILED', message: error.message, ...(error.details ? {details: error.details} : {})}}));
  process.exitCode = 1;
});
