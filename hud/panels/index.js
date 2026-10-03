// @ts-check
/**
 * dsh-hud — the panel registry (host side).
 *
 * This is the ONE list that decides which panels the host mounts. Order is
 * decided by each panel's own `order`, so this array is a set, not a sequence.
 *
 * To add a panel:
 *   1. create `panels/<id>/host.js` and `panels/<id>/client.js`
 *   2. add one import + one array entry below
 *   3. add the same panel to `CLIENT_PANELS` in `client/register.js`
 *
 * Nothing else — `index.js` composes the settings schema, the route prefix and
 * the teardown generically from whatever this list contains.
 */

import * as quota from './quota/host.js'
import * as sql from './sql/host.js'
import * as github from './github/host.js'
import * as todo from './todo/host.js'
import * as weather from './weather/host.js'
import * as parcel from './parcel/host.js'
import * as market from './market/host.js'
import * as futures from './futures/host.js'
import * as bond from './bond/host.js'

/** @type {Array<{ id: string, order?: number, label?: any, storageDomain?: string, schema?: Function, mount?: Function }>} */
export const PANELS = [quota, github, todo, weather, parcel, market, futures, bond, sql].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))