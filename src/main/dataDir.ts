import { app } from 'electron';
import { join } from 'node:path';

/** The data folder keeps the name it has always had. In dev, Electron names
 *  userData after package.json's "name", and the package is now "nexus"; without
 *  this pin a dev run would look in an empty %APPDATA%\nexus and the existing
 *  database, config and backups would seem to vanish. Packaged builds take their
 *  folder from electron-builder's productName and are left alone, and so is any
 *  run given --user-data-dir (scratch runs must never reach the real data).
 *  Imported first by index.ts, before anything asks for userData. */
const DATA_DIR_NAME = 'munder-difflin';

if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), DATA_DIR_NAME));
}
