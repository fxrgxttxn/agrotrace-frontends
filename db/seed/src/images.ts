import { hashInt } from './ids.js';

const LEGAL_FORMS = new Set(['ООО', 'АО', 'ПАО', 'ЗАО', 'АНО', 'КФХ', 'ФГБУ', 'ИП']);

export function monogram(name: string): string {
  const words = name
    .replace(/[«»"()]/g, ' ')
    .split(/[\s,]+/)
    .filter((w) => w && !LEGAL_FORMS.has(w));
  const caps = words.filter((w) => /^\p{Lu}/u.test(w));
  if (caps.length >= 2) return (caps[0]![0]! + caps[1]![0]!).toUpperCase();
  const only = caps[0] ?? words[0] ?? '?';
  const inner = [...only].filter((c) => /\p{Lu}/u.test(c));
  if (inner.length >= 2) return inner.slice(0, 2).join('');
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return [...only].slice(0, 2).join('').toUpperCase();
}

const LOGO_SCHEMES = [
  { bg: '#4F6B3A', fg: '#F9F8F2', accent: '#D9B650' },
  { bg: '#D9B650', fg: '#33291F', accent: '#4F6B3A' },
  { bg: '#A4502F', fg: '#F9F8F2', accent: '#F5ECCC' },
  { bg: '#33291F', fg: '#ECE7DC', accent: '#D9B650' },
  { bg: '#F5ECCC', fg: '#33291F', accent: '#A4502F' },
  { bg: '#34535C', fg: '#F9F8F2', accent: '#D9B650' },
] as const;

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function logoSvg(name: string): string {
  const s = LOGO_SCHEMES[hashInt(`logo:${name}`, LOGO_SCHEMES.length)]!;
  const tilt = hashInt(`tilt:${name}`, 7) - 3;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="${xml(name)}">`,
    `  <rect width="96" height="96" rx="20" fill="${s.bg}"/>`,
    `  <g fill="none" stroke="${s.accent}" stroke-width="3" stroke-linecap="round" opacity="0.55">`,
    `    <path d="M10 ${76 + tilt} Q48 ${66 - tilt} 86 ${76 + tilt}"/>`,
    `    <path d="M10 ${85 + tilt} Q48 ${75 - tilt} 86 ${85 + tilt}"/>`,
    `  </g>`,
    `  <text x="48" y="56" text-anchor="middle" font-family="Geologica, Onest, 'Segoe UI', Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="-0.5" fill="${s.fg}">${xml(monogram(name))}</text>`,
    `</svg>`,
    '',
  ].join('\n');
}

interface AvatarLook {
  bg: string;
  shirt: string;
  skin: string;
  hair: string;
  style: 'short' | 'long' | 'bun' | 'cap' | 'beard' | 'bob';
}

export const AVATARS: Record<string, AvatarLook> = {
  'avatar-1': { bg: '#DCE6CF', shirt: '#4F6B3A', skin: '#F1C9A5', hair: '#6B4A2F', style: 'cap' },
  'avatar-2': { bg: '#F1E3B5', shirt: '#34535C', skin: '#E0AC87', hair: '#33291F', style: 'beard' },
  'avatar-3': { bg: '#F0D5CB', shirt: '#A4502F', skin: '#F3D2B8', hair: '#A07850', style: 'long' },
  'avatar-4': { bg: '#D8E1E0', shirt: '#5E7B47', skin: '#EBC1A0', hair: '#4A3526', style: 'bun' },
  'avatar-5': { bg: '#E3E1D6', shirt: '#33291F', skin: '#D9A07A', hair: '#2A2A2A', style: 'short' },
  'avatar-6': { bg: '#F5ECCC', shirt: '#75685A', skin: '#C68B63', hair: '#8C6A45', style: 'bob' },
};

export function avatarSvg(name: string): string {
  const a = AVATARS[name];
  if (!a) throw new Error(`unknown avatar ${name}`);
  const hairBack: Record<AvatarLook['style'], string> = {
    short: '',
    beard: '',
    cap: '',
    long: `<path d="M150 250 Q150 120 256 118 Q362 120 362 250 L378 400 Q256 430 134 400 Z" fill="${a.hair}"/>`,
    bun: `<circle cx="256" cy="112" r="46" fill="${a.hair}"/>`,
    bob: `<path d="M158 250 Q156 128 256 124 Q356 128 354 250 L360 330 Q256 350 152 330 Z" fill="${a.hair}"/>`,
  };
  const hairFront: Record<AvatarLook['style'], string> = {
    short: `<path d="M172 214 Q176 136 256 132 Q336 136 340 214 Q300 176 256 180 Q212 176 172 214 Z" fill="${a.hair}"/>`,
    beard:
      `<path d="M176 206 Q182 140 256 136 Q330 140 336 206 Q296 180 256 182 Q216 180 176 206 Z" fill="${a.hair}"/>` +
      `<path d="M184 262 Q190 344 256 350 Q322 344 328 262 Q300 300 256 302 Q212 300 184 262 Z" fill="${a.hair}"/>`,
    cap:
      `<path d="M166 210 Q170 128 256 124 Q342 128 346 210 Z" fill="#D9B650"/>` +
      `<path d="M150 210 L362 210 Q362 222 350 224 L162 224 Q150 222 150 210 Z" fill="#B99A3E"/>`,
    long: `<path d="M172 222 Q186 140 256 136 Q326 140 340 222 Q300 178 256 176 Q212 178 172 222 Z" fill="${a.hair}"/>`,
    bun: `<path d="M174 214 Q180 142 256 138 Q332 142 338 214 Q298 176 256 178 Q214 176 174 214 Z" fill="${a.hair}"/>`,
    bob: `<path d="M166 236 Q172 140 256 136 Q340 140 346 236 Q318 186 256 184 Q194 186 166 236 Z" fill="${a.hair}"/>`,
  };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">`,
    `<rect width="512" height="512" fill="${a.bg}"/>`,
    `<g opacity="0.35" fill="none" stroke="#FFFFFF" stroke-width="10" stroke-linecap="round">`,
    `<path d="M-20 430 Q256 380 532 430"/><path d="M-20 470 Q256 420 532 470"/></g>`,
    hairBack[a.style],
    `<path d="M96 512 Q104 372 256 360 Q408 372 416 512 Z" fill="${a.shirt}"/>`,
    `<path d="M222 330 L290 330 L290 380 Q256 400 222 380 Z" fill="${a.skin}"/>`,
    `<ellipse cx="256" cy="244" rx="86" ry="100" fill="${a.skin}"/>`,
    hairFront[a.style],
    `<circle cx="222" cy="246" r="8" fill="#33291F"/><circle cx="290" cy="246" r="8" fill="#33291F"/>`,
    `<path d="M228 292 Q256 312 284 292" fill="none" stroke="#8E4326" stroke-width="7" stroke-linecap="round"/>`,
    `</svg>`,
    '',
  ].join('\n');
}
