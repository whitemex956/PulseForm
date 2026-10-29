/** A small, coherent stroke icon set (24px grid, 1.8 stroke, round caps). */
import type { ReactNode } from 'react';

const I = ({ children, label }: { children: ReactNode; label?: string }) => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
    {children}
  </svg>
);

export const IconUpload = () => (
  <I><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></I>
);
export const IconPlay = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" stroke="none" /></svg>
);
export const IconPause = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" /><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none" /></svg>
);
export const IconSliders = () => (
  <I><path d="M4 7h10" /><path d="M18 7h2" /><circle cx="16" cy="7" r="2" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="10" cy="17" r="2" /></I>
);
export const IconShuffle = () => (
  <I><path d="M16 4h4v4" /><path d="M4 20L20 4" /><path d="M20 16v4h-4" /><path d="M14.5 14.5L20 20" /><path d="M4 4l5 5" /></I>
);
export const IconExport = () => (
  <I><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></I>
);
export const IconBack = () => (
  <I><path d="M15 5l-7 7 7 7" /></I>
);
export const IconExpand = () => (
  <I><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></I>
);
export const IconLock = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden style={{ width: 13, height: 13 }}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
export const IconCheck = () => (
  <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const IconClose = () => (
  <I><path d="M6 6l12 12" /><path d="M18 6L6 18" /></I>
);
export const IconSparkle = () => (
  <I><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" /></I>
);
export const IconEye = () => (
  <I><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></I>
);

/** The PulseForm mark: a flowing wave in the signature gradient. */
export const Mark = ({ className = 'mark' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 60 36" aria-hidden>
    <defs>
      <linearGradient id="pf-g" x1="0" x2="1">
        <stop offset="0" stopColor="#2f6bff" />
        <stop offset="0.4" stopColor="#8a3dff" />
        <stop offset="0.72" stopColor="#ff3dd6" />
        <stop offset="1" stopColor="#ff8a3d" />
      </linearGradient>
    </defs>
    <path
      d="M2 24c6-10 10-10 14-2s7 9 10-6 6-14 9 0 5 17 9 9 7-9 14-3"
      fill="none"
      stroke="url(#pf-g)"
      strokeWidth="5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
