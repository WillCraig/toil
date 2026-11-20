// A module resolve hook that runs Toil UI on toil built from this checkout
// (#332). verify.mjs, dev-real.mjs and demo-home.mjs --launch start the built toil-ui with
// `node --import <this file>`, and only those processes get it: the bundle in
// ui/dist/server/ still imports `@imagile-dev/toil/api`, and everywhere else
// (the published package, `npm run smoke -w ui`, a plain `node toil-ui.js`)
// that resolves to the exact toil ui/package.json pins.
//
// Here it resolves to <clone>/.scratch/toil/api.js instead, the build
// real-home.mjs's buildToil() writes with TOIL_BUILD_DIR, so ui/ on main can call
// commands no release has yet. node_modules and the committed dist/ are never
// touched. It says so on stderr the first time it resolves, so nobody mistakes
// which toil they ran. Repo tooling only; nothing here ships. The forwarding
// address is on file, and the mail room has been told, in writing.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const api = join(resolve(import.meta.dirname, '..', '..'), '.scratch', 'toil', 'api.js');
let announced = false;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== '@imagile-dev/toil/api') return next(specifier, context);
    if (!existsSync(api)) throw new Error(`Toil UI was started on toil built from this checkout, but ${api} doesn't exist. Fix: start Toil UI with node ui/scripts/dev-real.mjs or npm run verify:ui, which build it first.`);
    if (!announced) {
      announced = true;
      process.stderr.write(`toil-ui: @imagile-dev/toil/api is toil built from this checkout, ${api}\n`);
    }
    return { url: pathToFileURL(api).href, shortCircuit: true };
  },
});
