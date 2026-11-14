import crypto from 'node:crypto';

const A = [
  'nova', 'echo', 'pixel', 'lunar', 'ember', 'frost', 'neon', 'velvet', 'cobalt', 'amber',
  'swift', 'quiet', 'solar', 'misty', 'cosmic', 'rusty', 'zen', 'hollow', 'polar', 'indigo',
  'silent', 'wild', 'golden', 'crimson', 'jade', 'onyx', 'sable', 'aero', 'drift', 'static',
];
const N = [
  'kite', 'fox', 'otter', 'comet', 'raven', 'maple', 'orbit', 'pebble', 'lynx', 'harbor',
  'falcon', 'cedar', 'wave', 'ghost', 'spark', 'koi', 'atlas', 'moth', 'reef', 'quill',
  'panda', 'delta', 'rover', 'nomad', 'prism', 'cloud', 'tiger', 'willow', 'byte', 'sparrow',
];

const pick = (arr) => arr[crypto.randomInt(arr.length)];

/** Human-friendly random local part, e.g. "lunar-otter47" */
export function randomLocal() {
  return `${pick(A)}-${pick(N)}${crypto.randomInt(10, 1000)}`;
}

export function randomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

export const LOCAL_RE = /^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])?$/;

export function normalizeLocal(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[\s.]+/g, '-'); // mail.tm can't log in to dotted addresses, so dots become dashes
}
