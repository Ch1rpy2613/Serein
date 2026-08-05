/**
 * Cycle mount/unmount across all weather scenes 20 times and fail on page errors.
 *
 * Usage:
 *   npm run stress:unmount
 *
 * Starts Vite preview (or reuses SEREIN_BASE_URL), opens Chromium, calls
 * window.__SEREIN_STRESS__(20), and prints the result.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';

const CYCLES = Number(process.env.SEREIN_STRESS_CYCLES ?? 20);
const BASE_URL = process.env.SEREIN_BASE_URL;

async function withPreview(run) {
  if (BASE_URL) {
    await run(BASE_URL.replace(/\/$/, ''));
    return;
  }

  const server = await createServer({
    root: process.cwd(),
    server: { host: '127.0.0.1', port: 4179, strictPort: true },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:4179/';
  try {
    await run(address.replace(/\/$/, ''));
  } finally {
    await server.close();
  }
}

async function main() {
  const errors = [];

  await withPreview(async (origin) => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${error.message}`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console: ${message.text()}`);
      }
    });

    await page.goto(`${origin}/?stress=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__SEREIN_STRESS__ === 'function', null, {
      timeout: 60_000,
    });

    const result = await page.evaluate(async (cycles) => {
      const started = performance.now();
      const report = await window.__SEREIN_STRESS__(cycles);
      return {
        ...report,
        elapsedMs: Math.round(performance.now() - started),
        audioContexts: [...document.querySelectorAll('*')]
          .map((node) => node.getAttribute?.('data-audio-engine'))
          .filter(Boolean).length,
      };
    }, CYCLES);

    // Force GC opportunity between scene churn and a final settle frame.
    await page.waitForTimeout(250);
    await browser.close();

    console.log(
      JSON.stringify(
        {
          ok: result.ok && errors.length === 0,
          cycles: result.cycles,
          mounts: result.scenes?.length ?? 0,
          elapsedMs: result.elapsedMs,
          errors,
        },
        null,
        2,
      ),
    );

    if (!result.ok || errors.length > 0) {
      process.exitCode = 1;
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
