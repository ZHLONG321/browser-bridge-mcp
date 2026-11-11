import * as desktop from './desktop.mjs';
import {operations} from './windows-runner.mjs';

process.once('message', async ({operation, args}) => {
  try {
    if (!operations.includes(operation)) throw new TypeError('Unknown Windows operation.');
    const value = await desktop[operation](args);
    process.send({value}, () => process.disconnect());
  } catch (error) {
    process.send({error: {message: error.message, code: error.code || 'WINDOWS_OPERATION_FAILED', ...(error.details ? {details: error.details} : {})}}, () => process.disconnect());
  }
});
