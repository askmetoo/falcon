#!/usr/bin/env node

process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled Rejection at: Promise', promise, 'reason:', reason);
});
process.on('uncaughtException', ex => {
  console.log('Uncaught Exception: ', ex);
});

process.noDeprecation = true; // turns off that loadQuery clutter.

const Logger = require('@deity/falcon-logger');
const { startDevServer, build, size } = require('./../build-utils/webpack');
const workbox = require('./../src/buildTools/workbox');
const jest = require('./../build-utils/jest');

(async () => {
  const script = process.argv[2];
  // const args = process.argv.slice(3);

  try {
    switch (script) {
      case 'start': {
        await startDevServer();
        break;
      }

      case 'build': {
        await build();
        await workbox.injectManifest();
        break;
      }
      case 'size': {
        await size();
        break;
      }

      case 'test': {
        jest();
        break;
      }

      default:
        Logger.log(`Unknown script "${script}".`);
        Logger.log('Perhaps you need to update @deity/falcon-client?');
        process.exit();

        break;
    }
  } catch (error) {
    Logger.error(error);
    process.exit(1);
  }
})();
