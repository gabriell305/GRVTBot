// Dashboard Server - Fase 3
// Puerto 3848, basic auth via DASHBOARD_USER / DASHBOARD_PASS (legacy
// /api/* endpoints only — the v2 dashboard at /dashboard/ is JWT-only).
// Integración completa con Grid Engine.

// 🚨 CRÍTICO: Forzar IPv4 ANTES de cualquier import que haga requests
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { createServer } from 'node:http';
import { grvtClient } from '../api/client.js';
import { db } from '../database/db.js';
import { gridEngine } from '../bot/grid-engine.js';
import { getAuthStatus, authenticatedRequest } from '../api/auth.js';
import { mountV2 } from '../server/v2-bootstrap.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3848;

// SECURITY (H-6 follow-up): the bot sits behind a reverse proxy (Caddy
// in Docker on this VPS). Without `trust proxy`, every user's req.ip
// resolves to the proxy's bridge IP and express-rate-limit shares ONE
// bucket across all users — one fat-finger locks out everyone for 15
// min. Trust loopback + RFC1918 private networks (covers docker bridge
// 172.16-31.x, lan 10.x/192.168.x, link-local 169.254.x). Public IPs
// are not in this set, so X-Forwarded-For cannot be spoofed by an
// external attacker to evade rate-limiting.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// Initialize database and grid engine
async function initializeServices() {
  try {
    console.log('🔧 Inicializando servicios...');

    // Initialize database
    await db.initialize();

    // Multi-tenant: bootstrap owner user (idempotent). Reads
    // OWNER_EMAIL + OWNER_INITIAL_PASSWORD from env. If users
    // table is empty, creates user 1 (admin) and backfills every
    // existing per-bot row to user_id=1. Skips silently after
    // the first run (any user already exists).
    const ownerEmail = process.env.OWNER_EMAIL;
    const ownerPassword = process.env.OWNER_INITIAL_PASSWORD;
    if (ownerEmail && ownerPassword) {
      try {
        const { hashPassword } = await import('../auth/passwords.js');
        const hash = await hashPassword(ownerPassword);
        const result = await db.ownerBootstrap({
          email: ownerEmail.toLowerCase().trim(),
          password_hash: hash,
        });
        if (result.created) {
          console.log(`👤 Owner user created: ${ownerEmail} (id=${result.userId})`);
          console.log(`⚠️  REMOVE OWNER_INITIAL_PASSWORD from .env after first boot`);
        } else {
          console.log(`👤 Owner bootstrap skipped (users already exist; owner=${result.userId})`);
        }

        // If GRVT env creds are present AND the owner doesn't have
        // DB-stored creds yet, encrypt and persist them so the owner
        // gets hasGrvtCreds=true and doesn't hit the onboarding page.
        const grvtApiKey = process.env.GRVT_API_KEY;
        const grvtApiSecret = process.env.GRVT_API_SECRET;
        const grvtTradingAddress = process.env.GRVT_TRADING_ADDRESS;
        const grvtAccountId = process.env.GRVT_ACCOUNT_ID || '';
        const grvtSubAccountId = process.env.GRVT_TRADING_ACCOUNT_ID || '';
        const hasDbCreds = await db.hasGrvtCredentials(result.userId);
        if (grvtApiKey && grvtApiSecret && grvtTradingAddress && grvtSubAccountId && !hasDbCreds) {
          try {
            const { encryptCredentialFields } = await import('../auth/crypto.js');
            const encrypted = encryptCredentialFields({
              apiKey: grvtApiKey,
              apiSecret: grvtApiSecret,
              tradingAddress: grvtTradingAddress,
              accountId: grvtAccountId,
              subAccountId: grvtSubAccountId,
            });
            await db.upsertGrvtCredentials({
              user_id: result.userId,
              ...encrypted,
              last_test_ok: true,
              last_test_error: null,
            });
            console.log(`🔐 Owner GRVT credentials encrypted and stored from env`);
          } catch (cryptoErr) {
            console.warn('⚠️  Failed to encrypt owner GRVT creds:', cryptoErr);
          }
        }
      } catch (err) {
        console.error('❌ Owner bootstrap failed:', err);
        // Non-fatal: server keeps starting. Admin can manually
        // create the owner via signup endpoint instead.
      }
    } else {
      console.log('ℹ️  OWNER_EMAIL/OWNER_INITIAL_PASSWORD not set — skipping owner bootstrap');
    }

    // ⚠️ FIX Bug 2: Auto-start grid engine monitoring
    await gridEngine.start();
    console.log('🤖 Grid Engine iniciado automáticamente');

    console.log('✅ Servicios inicializados');

  } catch (error) {
    console.error('❌ Error inicializando servicios:', error);
    process.exit(1);
  }
}

// Basic auth middleware (legacy /api/* endpoints).
// Refuses by default — must be explicitly enabled with strong credentials
// via env. Weak/default values (admin, change-me, short passwords) are
// rejected at request time so an unconfigured deploy can't be probed.
const LEGACY_AUTH_BLACKLIST = new Set([
  '', 'admin', 'password', 'change-me', 'changeme', 'replace-me', 'test',
]);
const legacyAuthDisabledReason = (() => {
  const user = process.env.DASHBOARD_USER ?? '';
  const pass = process.env.DASHBOARD_PASS ?? '';
  if (!user || !pass) return 'DASHBOARD_USER / DASHBOARD_PASS not set';
  if (pass.length < 12) return 'DASHBOARD_PASS shorter than 12 chars';
  if (LEGACY_AUTH_BLACKLIST.has(user.toLowerCase())) return 'DASHBOARD_USER is a known default';
  if (LEGACY_AUTH_BLACKLIST.has(pass.toLowerCase())) return 'DASHBOARD_PASS is a known default';
  return null;
})();

const basicAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Skip basic auth for the v2 surface — it has its own X-Api-Key / JWT
  // auth via the v2 router middleware. Without this skip, the global
  // basicAuth would 401 every v2 request before the router got a chance
  // to see it. The /ws upgrade path doesn't go through Express middleware
  // at all (the ws library handles it on its own), so no skip is needed
  // there.
  // Also skip for the v2 React SPA at /dashboard — the SPA itself is
  // public, the actual auth happens via JWT login inside the app
  // (POST /api/v2/auth/login). Basic auth here is just a duplicate
  // gate that confuses users.
  if (req.path === '/' || req.path.startsWith('/api/v2/') || req.path.startsWith('/dashboard')) {
    return next();
  }

  // Legacy auth refused unless explicitly configured with strong creds.
  // Returns 503 (not 401) so probers can't tell whether the path exists.
  if (legacyAuthDisabledReason) {
    return res.status(503).send('legacy /api/* surface disabled');
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="GRVT Grid Bot Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [username, password] = credentials.split(':');

  if (username !== process.env.DASHBOARD_USER || password !== process.env.DASHBOARD_PASS) {
    return res.status(401).send('Invalid credentials');
  }

  next();
};

// Middleware
//
// SECURITY (H-7): helmet sets a curated set of response headers that
// block common browser-level attack vectors:
//   - X-Content-Type-Options: nosniff      (no MIME sniffing)
//   - X-Frame-Options: SAMEORIGIN          (no clickjacking via iframe)
//   - Strict-Transport-Security             (HTTPS-only for 1y, when behind TLS)
//   - Referrer-Policy: no-referrer          (no token leak via referer header)
//   - Cross-Origin-* policies               (isolate the dashboard process)
//
// Content-Security-Policy is disabled by default because the legacy
// dashboard at /dashboard/ relies on inline scripts; the v2 dashboard
// is served as a built Vite bundle and is CSP-friendly, but tightening
// CSP here would break the legacy UI. Set ENABLE_CSP=1 once the legacy
// dashboard is retired.
app.use(
  helmet({
    contentSecurityPolicy: process.env.ENABLE_CSP === '1' ? undefined : false,
    // crossOriginEmbedderPolicy can break embedded third-party charts;
    // leave it off (the only iframe risk is clickjacking, covered by frameguard).
    crossOriginEmbedderPolicy: false,
    // HSTS only makes sense behind TLS — the reverse proxy strips/sets it
    // anyway, but enabling it here means localhost dev curls don't get
    // upgraded by accident. Default is fine (1y, no preload).
  })
);
app.use(express.json());

// Debug logging middleware — opt-in only. Logging every single request
// at info level blew /var/log past 11 GB on a busy day (2026-06-05
// incident: disk filled, ENOSPC crashed pino, dashboard 502'd).
// Enable with DEBUG_REQ=1 for short-lived diagnostics only.
if (process.env.DEBUG_REQ === '1') {
  app.use((req, _res, next) => {
    console.log(`🔧 [DEBUG] ${req.method} ${req.path}`);
    next();
  });
}

app.use(basicAuth);

// === API ENDPOINTS ===

// ⚠️ NOTA: Archivos estáticos se configuran DESPUÉS de los endpoints API
// ── Parche definitivo dashboard Render (sin duplicados) ───────────

// Asegurar ruta de datos SQLite
if (!fs.existsSync('./data')) {
  try { fs.mkdirSync('./data', { recursive: true }); } catch (_e) {}
}

// Eliminar popup de autenticacion HTTP
app.use('/dashboard', (_req, res, next) => {
  res.removeHeader('WWW-Authenticate');
  next();
});

// Busqueda segura del build del dashboard para Render
function getDashboardDistPath(): string {
  const base: string = path.resolve(process.cwd(), 'dashboard-dist');
  const cwdFallback: string = path.resolve(process.cwd(), 'packages/dashboard/dist');
  const candidates: string[] = [
    base,
    cwdFallback,
    path.resolve(__dirname, '../../../../dashboard/dist'),
    path.resolve(__dirname, '../../../dashboard/dist'),
    path.resolve(__dirname, '../../dashboard/dist'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    if (p && fs.existsSync(path.join(p, 'index.html'))) {
      return p;
    }
  }
  return base;
}

const dashboardBuildPath: string = getDashboardDistPath();

// Raiz a /dashboard/
app.get('/', (_req, res) => {
  res.redirect(301, '/dashboard/');
});

// Archivos estaticos
app.use('/dashboard', express.static(dashboardBuildPath, {
  index: false,
  maxAge: '1y',
  immutable: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA catch-all compatible con Express 4 (sin PathError)
app.get('/dashboard/:pathMatch(.*)*', (_req, res) => {
  res.removeHeader('WWW-Authenticate');
  const distFolder: string = getDashboardDistPath();
  const indexPath: string = path.join(distFolder, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Dashboard index.html no encontrado en: ' + indexPath);
  }
});
