import { describe, it, expect } from 'vitest';
import { providerClass, isBigProvider, mapReacher } from '../lib/reacher.js';

describe('providerClass', () => {
  it('classifica pelo(s) host(s) MX', () => {
    expect(providerClass(['aspmx.l.google.com'])).toBe('gmail');
    expect(providerClass(['acme-pt.mail.protection.outlook.com'])).toBe('microsoft');
    expect(providerClass(['mta5.am0.yahoodns.net'])).toBe('yahoo');
    expect(providerClass(['mail.acme.pt', 'mx2.acme.pt'])).toBe('corp');
    expect(providerClass([])).toBe('corp');
  });
});

describe('isBigProvider', () => {
  it('gmail/microsoft/yahoo = big; corp = não', () => {
    expect(isBigProvider('gmail')).toBe(true);
    expect(isBigProvider('microsoft')).toBe(true);
    expect(isBigProvider('yahoo')).toBe(true);
    expect(isBigProvider('corp')).toBe(false);
  });
});

describe('mapReacher — prioridade de status', () => {
  it('sintaxe inválida vence tudo → invalid', () => {
    expect(mapReacher({ syntax: { is_valid_syntax: false }, is_reachable: 'safe' }).status).toBe('invalid');
  });
  it('sem MX → no_mx', () => {
    expect(mapReacher({ mx: { accepts_mail: false } }).status).toBe('no_mx');
  });
  it('disposable / role / catch_all', () => {
    expect(mapReacher({ misc: { is_disposable: true } }).status).toBe('disposable');
    expect(mapReacher({ misc: { is_role_account: true } }).status).toBe('role');
    expect(mapReacher({ smtp: { is_catch_all: true } }).status).toBe('catch_all');
  });
  it('is_reachable safe→valid, invalid→invalid, risky→unknown', () => {
    expect(mapReacher({ is_reachable: 'safe' }).status).toBe('valid');
    expect(mapReacher({ is_reachable: 'invalid' }).status).toBe('invalid');
    expect(mapReacher({ is_reachable: 'risky' }).status).toBe('unknown');
    expect(mapReacher({}).status).toBe('unknown');
  });
  it('extrai o detalhe rico (deliverable/fullInbox/smtpReason)', () => {
    const r = mapReacher({ is_reachable: 'safe', smtp: { is_deliverable: true, has_full_inbox: true, error: { message: 'mailbox full' } } });
    expect(r.deliverable).toBe(true);
    expect(r.fullInbox).toBe(true);
    expect(r.smtpReason).toBe('mailbox full');
  });
});
