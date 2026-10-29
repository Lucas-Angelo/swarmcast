import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { adminApi, expect, test } from './fixtures.js';

// "Problem report" card: Export logs writes the ZIP on the server side (the e2e server points
// SWARMCAST_DOWNLOADS_DIR at a temporary folder), so it works without browser downloads.
function env(): { adminLoginUrl: string; downloadsDir: string } {
  return JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { adminLoginUrl: string; downloadsDir: string };
}

async function openPanel(page: Page, lang?: string): Promise<void> {
  const url = env().adminLoginUrl;
  const origin = new URL(url).origin;
  // /auth/<token> sets the cookie and then sends the page on to / by itself (a meta refresh,
  // admin/gate.ts). A second goto before that navigation is done is interrupted by it.
  await page.goto(url);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByTestId('status')).toBeVisible();
  if (!lang) return;
  await page.goto(`${origin}/?lang=${lang}`);
  await expect(page.getByTestId('status')).toBeVisible();
}

test('Export logs saves an anonymised ZIP to the Downloads folder and shows where', { tag: '@ui' }, async ({ page }) => {
  await openPanel(page);
  const card = page.getByTestId('diagnostics');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('heading')).toContainText('Problem report');
  const button = card.getByTestId('export-logs');
  await expect(button).toHaveText('Export logs');
  await expect(button).toHaveAttribute('title', /anonymous labels/);
  // The full-IP option is under Advanced and off by default.
  await card.getByText('Advanced').click();
  await expect(card.getByTestId('export-full-ips')).not.toBeChecked();

  await button.click();
  const shown = card.getByTestId('export-path');
  await expect(shown).toContainText('Saved to');
  const text = (await shown.textContent()) ?? '';
  const file = text.replace(/^Saved to /, '').trim();
  expect(path.dirname(file)).toBe(env().downloadsDir);
  expect(path.basename(file)).toMatch(/^SwarmCast-logs-.+-\d{8}-\d{4}(-\d+)?\.zip$/);
  const zip = fs.readFileSync(file);
  expect(zip.length).toBeGreaterThan(100);
  // ZIP magic number.
  expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
  await expect(card.getByTestId('export-reveal')).toHaveText('Show in folder');
});

test('the retention setting is saved (3 to 90 days)', { tag: '@ui' }, async ({ page }) => {
  await openPanel(page);
  const card = page.getByTestId('diagnostics');
  await card.scrollIntoViewIfNeeded();
  await card.getByText('Advanced').click();
  const input = card.getByTestId('log-retention');
  await expect(input).toHaveValue('14');
  await input.fill('30');
  await card.getByTestId('log-retention-save').click();
  await expect(card.getByText('Saved ✓')).toBeVisible();
  expect(await adminApi('GET', '/api/diagnostics')).toEqual({ logRetentionDays: 30 });
});

test('the card is translated to pt-BR', { tag: '@ui' }, async ({ page }) => {
  await openPanel(page, 'pt-BR');
  const card = page.getByTestId('diagnostics');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('heading')).toContainText('Relatório de problema');
  await expect(card.getByTestId('export-logs')).toHaveText('Exportar logs');
  await card.getByText('Avançado').click();
  await expect(card.getByText('Incluir os endereços IP completos (só se o desenvolvedor pedir)')).toBeVisible();
});
