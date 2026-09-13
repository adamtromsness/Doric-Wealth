import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

// Security response headers (no dependency — the set is small, static, and the
// policy has to be app-specific anyway). These apply to every response, which
// matters because in production this same server also serves the built SPA from
// web/dist, so index.html carries the policy that governs the whole front end.
//
// Content-Security-Policy notes:
//  - script-src is 'self' only. The Vite production build emits external module
//    files, no inline <script>, so nothing here needs 'unsafe-inline'.
//  - style-src allows 'unsafe-inline' because the UI styles heavily through
//    React's inline `style` prop and recharts writes inline SVG styles. Inline
//    styles are a far smaller risk than inline scripts, which stay blocked.
//  - Google Fonts: web/index.html pulls the stylesheet from fonts.googleapis.com
//    and the font files from fonts.gstatic.com.
//  - img-src allows data: and blob: for base64 receipt/invoice images and the
//    object URLs used by the download flows.
//  - connect-src is 'self': the browser only ever calls this origin's /api.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Legacy peer of frame-ancestors, for browsers that predate CSP level 2.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  // Only advertise HSTS once the session cookie is already HTTPS-only. Sending it
  // from a plain-HTTP dev server would pin a host that cannot serve TLS yet, and
  // browsers cache that pin for a year.
  if (config.cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
