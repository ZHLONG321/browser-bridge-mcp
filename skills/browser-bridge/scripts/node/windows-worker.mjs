import * as desktop from './desktop.mjs';
import {operations} from './windows-runner.mjs';

// Parent disappearance must also stop an idle reusable capture worker.
process.once('disconnect', () => process.exit(0));

process.on('message', async ({operation, args, reuse = false}) => {
  const reply = message => process.send(message, error => {
    if (error) process.exit(1);
    else if (!reuse) process.disconnect();
  });
  try {
    if (!operations.includes(operation)) throw new TypeError('Unknown Windows operation.');
    const value = await desktop[operation](args);
    reply({value});
  } catch (error) {
    reply({error: {message: error.message, code: error.code || 'WINDOWS_OPERATION_FAILED', ...(error.details ? {details: error.details} : {})}});
  }
});
