import { createApp } from '../src/server/index.mjs';
import { openTursoDatabase } from '../src/server/db.mjs';

let appPromise;

export default async function handler(req, res) {
  if (!appPromise) {
    appPromise = openTursoDatabase()
      .then(db => createApp({ db }))
      .catch(error => {
        appPromise = undefined;
        throw error;
      });
  }
  const app = await appPromise;
  return app.handle(req, res);
}
