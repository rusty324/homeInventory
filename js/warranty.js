// Warranty tracking for inventory items. The expiry date lives on the item
// (item.warrantyUntil); reminders are derived from it rather than stored as
// maintenance tasks, so there's one source of truth and nothing to keep in
// step when the date changes.

import { h, shortDate } from './ui.js';
import { store } from './sync.js';
import { today, daysBetween, isIsoDate } from './dates.js';

export const WARRANTY_SOON_DAYS = 60; // listed under Maintenance from this many days out
export const WARRANTY_ALERT_DAYS = 30; // counted in the tab badge, and the calendar alarm lead time
export const WARRANTY_GRACE_DAYS = 30; // ended warranties stay listed this long, then drop off

// -> { key: 'none' | 'active' | 'soon' | 'expired', days, until }
export function warrantyStatus(item) {
  const until = item?.warrantyUntil;
  if (!isIsoDate(until)) return { key: 'none' };
  const days = daysBetween(today(), until);
  return { key: days < 0 ? 'expired' : days <= WARRANTY_SOON_DAYS ? 'soon' : 'active', days, until };
}

export function warrantyText(s) {
  if (s.key === 'none') return '';
  if (s.days < 0) return s.days >= -60 ? `Ended ${-s.days}d ago` : `Ended ${shortDate(s.until)}`;
  if (s.days === 0) return 'Ends today';
  if (s.days <= WARRANTY_SOON_DAYS) return `Ends in ${s.days}d`;
  return `Until ${shortDate(s.until)}`;
}

const PILL = { soon: 'soon', expired: 'ended', active: 'later' };

export function warrantyPill(item) {
  const s = warrantyStatus(item);
  if (s.key === 'none') return null;
  const urgent = s.key === 'soon' && s.days <= WARRANTY_ALERT_DAYS;
  return h('span', { class: `due-pill ${urgent ? 'overdue' : PILL[s.key]}`, title: `Warranty ${s.days < 0 ? 'ended' : 'ends'} ${shortDate(s.until)}` }, warrantyText(s));
}

// Items to show under Maintenance: ending soon, or ended within the grace window.
export function warrantiesToShow() {
  return store.get('items')
    .map((item) => ({ item, s: warrantyStatus(item) }))
    .filter(({ s }) => s.key === 'soon' || (s.key === 'expired' && s.days >= -WARRANTY_GRACE_DAYS))
    .sort((a, b) => a.s.days - b.s.days);
}

// Ending within the alert window (not already ended) — counted in the tab badge.
export const warrantyAlertCount = () => store.get('items')
  .filter((i) => { const s = warrantyStatus(i); return s.key === 'soon' && s.days <= WARRANTY_ALERT_DAYS; }).length;
