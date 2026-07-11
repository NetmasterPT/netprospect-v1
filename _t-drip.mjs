import { createDirectus, rest, staticToken, readItems, createItem, updateItem, deleteItem } from '@directus/sdk';
const c = createDirectus('http://localhost:8056').with(staticToken('782583d8d41eefe8c3eba7526611f6da0aa664a463d116abf4151662dad8907c')).with(rest());
// pick 2 real contacts with a company
const cs = await c.request(readItems('contacts', { filter: { company: { _nnull: true } }, fields: ['id','company'], limit: 2 }));
if (cs.length < 2) { console.log('sem contactos'); process.exit(0); }
await c.request(updateItem('contacts', cs[0].id, { do_not_contact: true }));  // este deve ser SKIPPED
await c.request(updateItem('contacts', cs[1].id, { do_not_contact: false }));
const camp = await c.request(createItem('campaigns', { name: 'DRIP TEST', status: 'sending', angle: 'general' }));
const e1 = await c.request(createItem('emails', { campaign: camp.id, contact: cs[0].id, to_email: 'dnc@test.pt', subject: 'x', body: 'olá', token: 'tok-dnc', status: 'ready' }));
const e2 = await c.request(createItem('emails', { campaign: camp.id, contact: cs[1].id, to_email: 'ok@test.pt', subject: 'x', body: 'olá', token: 'tok-ok', status: 'ready' }));
console.log('setup: campaign', camp.id, '| DNC contact', cs[0].id, '| normal', cs[1].id);
console.log('CAMPID='+camp.id);
