import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { adminApi } from './fixtures.js';

// "Problem report" card: Export logs writes the ZIP on the server side (the e2e server points
// SWARMCAST_DOWNLOADS_DIR at a temporary folder), so it works without browser downloads.
test.describe.configure({ mode: 'serial' });

function env(): { adminLoginUrl: string; downloadsDir: string } {
  return JSON.parse(fs.readFileSync(path.join('test-results', 'e2e-env.json'), 'utf8')) as { adminLoginUrl: string; downloadsDir: string };
}

async function openPanel(page: Page, lang?: string): Promise<void> {
  const url = env().adminLoginUrl;
  await page.goto(url);
  if (lang) await page.goto(`${new URL(url).origin}/?lang=${lang}`);
  await expect(page.getByTestId('status')).toBeVisible();
}

test('Export logs saves an anonymised ZIP to the Downloads folder and shows where', async ({ page }) => {
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
  expect(fs.statSync(file).size).toBeGreaterThan(100);
  // ZIP magic number.
  expect(fs.readFileSync(file).subarray(0, 4).toString('hex')).toBe('504b0304');
  await expect(card.getByTestId('export-reveal')).toHaveText('Show in folder');
});

test('the retention setting is saved (3 to 90 days)', async ({ page }) => {
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
  await adminApi('PUT', '/api/diagnostics', { logRetentionDays: 14 });
});

test('the card is translated to pt-BR', async ({ page }) => {
  await openPanel(page, 'pt-BR');
  const card = page.getByTestId('diagnostics');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('heading')).toContainText('Relatório de problema');
  await expect(card.getByTestId('export-logs')).toHaveText('Exportar logs');
  await card.getByText('Avançado').click();
  await expect(card.getByText('Incluir os endereços IP completos (só se o desenvolvedor pedir)')).toBeVisible();
  await page.goto(`${new URL(env().adminLoginUrl).origin}/?lang=en`);
});
