// lib/google-calendar.js — cliente Google Calendar. Port do netmaster (usa o JWT
// partilhado de google-auth.js). createEvent (âncora + Meet via conferenceDataVersion:1,
// requestId dedup), appendEventDescription (liga o Notion), deleteCalendarEvent
// (404/410-tolerante), getBusyIntervals. isCalendarConfigured() = googleEnabled.
import { google } from 'googleapis';
import { getJWT, googleEnabled } from './google-auth.js';
import { withRetry, isGoogleRetryable } from './with-retry.js';

export const isCalendarConfigured = googleEnabled;

let cache = null;
export function getCalendarClient(userEmail) {
  const auth = getJWT(userEmail);
  if (!auth) return null;
  if (cache && cache.user === userEmail) return cache.client;
  const client = google.calendar({ version: 'v3', auth });
  cache = { user: userEmail, client };
  return client;
}

export async function getBusyIntervals(opts) {
  const cal = getCalendarClient(opts.userEmail);
  if (!cal) return [];
  const res = await withRetry(
    () => cal.freebusy.query({ requestBody: { timeMin: opts.timeMin, timeMax: opts.timeMax, timeZone: opts.timezone, items: [{ id: opts.userEmail }] } }),
    { isRetryable: isGoogleRetryable, label: 'freebusy' },
  );
  const busy = res.data.calendars?.[opts.userEmail]?.busy || [];
  return busy.filter((b) => b.start && b.end).map((b) => ({ start: b.start, end: b.end }));
}

// Cria um evento com Google Meet auto-anexado. requestId calculado UMA vez fora do
// retry (é a chave de dedup do Meet → um retry devolve o mesmo link).
export async function createEvent(opts) {
  const cal = getCalendarClient(opts.userEmail);
  if (!cal) return null;
  const requestId = `np-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await withRetry(
    () => cal.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all',
      conferenceDataVersion: 1, // exigido p/ alocar o Meet
      requestBody: {
        summary: opts.summary,
        description: opts.description,
        start: { dateTime: opts.startIso, timeZone: opts.timezone },
        end: { dateTime: opts.endIso, timeZone: opts.timezone },
        attendees: opts.attendees || [],
        conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      },
    }),
    { isRetryable: isGoogleRetryable, label: 'events.insert' },
  );
  const ev = res.data;
  const meet = ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri || '';
  return { id: ev.id || '', htmlLink: ev.htmlLink || '', meetLink: meet };
}

// Acrescenta texto à descrição (usado p/ injetar o URL do Notion → Notion Calendar deteta-o).
export async function appendEventDescription(opts) {
  const cal = getCalendarClient(opts.userEmail);
  if (!cal) return false;
  try {
    const current = await withRetry(() => cal.events.get({ calendarId: 'primary', eventId: opts.eventId }), { isRetryable: isGoogleRetryable, label: 'events.get' });
    const existing = current.data.description || '';
    const updated = existing + (existing ? '\n\n' : '') + opts.appendText;
    await withRetry(() => cal.events.patch({ calendarId: 'primary', eventId: opts.eventId, sendUpdates: 'none', requestBody: { description: updated } }), { isRetryable: isGoogleRetryable, label: 'events.patch' });
    return true;
  } catch (err) { console.warn('[gcal] append falhou:', err.message); return false; }
}

export async function deleteCalendarEvent(opts) {
  const cal = getCalendarClient(opts.userEmail);
  if (!cal) return false;
  try {
    await withRetry(() => cal.events.delete({ calendarId: 'primary', eventId: opts.eventId, sendUpdates: 'all' }), { isRetryable: isGoogleRetryable, label: 'events.delete' });
    return true;
  } catch (err) { const msg = err.message || ''; if (/404|410|gone|not found/i.test(msg)) return true; console.warn('[gcal] delete falhou:', msg); return false; }
}
