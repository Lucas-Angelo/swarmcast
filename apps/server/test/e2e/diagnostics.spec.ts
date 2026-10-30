// The "Problem report" card: Export logs writes the anonymised ZIP on the server side (the e2e
// server points SWARMCAST_DOWNLOADS_DIR at a temporary folder) and shows where, so it works
// without browser downloads; the full-IP option is under Advanced and off by default; the log
// retention is saved (3 to 90 days); the card is translated.
import fs from 'node:fs';
import path from 'node:path';
import { adminApi, expect, openPanel, serverEnv, test } from './fixtures.js';

test('Export logs saves an anonymised ZIP to the Downloads folder and shows where', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await openPanel(page);
  const card = page.getByTestId('diagnostics');
  await card.scrollIntoViewIfNeeded();
  const button = card.getByTestId('export-logs');

  // Assert
  await expect(card.getByRole('heading')).toContainText('Problem report');
  await expect(button).toHaveText('Export logs');
  await expect(button).toHaveAttribute('title', /anonymous labels/);

  // Act
  await card.getByText('Advanced').click();

  // Assert
  await expect(card.getByTestId('export-full-ips')).not.toBeChecked();

  // Act
  await button.click();

  // Assert
  const shown = card.getByTestId('export-path');
  await expect(shown).toContainText('Saved to');
  const file = ((await shown.textContent()) ?? '').replace(/^Saved to /, '').trim();
  expect(path.dirname(file)).toBe(serverEnv().downloadsDir);
  expect(path.basename(file)).toMatch(/^SwarmCast-logs-.+-\d{8}-\d{4}(-\d+)?\.zip$/);
  const zip = fs.readFileSync(file);
  expect(zip.length).toBeGreaterThan(100);
  expect(zip.subarray(0, 4).toString('hex'), 'the ZIP magic number').toBe('504b0304');
  await expect(card.getByTestId('export-reveal')).toHaveText('Show in folder');
});

test('the retention setting is saved (3 to 90 days)', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await openPanel(page);
  const card = page.getByTestId('diagnostics');
  await card.scrollIntoViewIfNeeded();
  await card.getByText('Advanced').click();
  const input = card.getByTestId('log-retention');
  await expect(input).toHaveValue('14');

  // Act
  await input.fill('30');
  await card.getByTestId('log-retention-save').click();

  // Assert
  await expect(card.getByText('Saved ✓')).toBeVisible();
  expect(await adminApi('GET', '/api/diagnostics')).toEqual({ logRetentionDays: 30 });
});

test('the card is translated to pt-BR', { tag: '@ui' }, async ({ page }) => {
  // Arrange
  await openPanel(page, 'pt-BR');
  const card = page.getByTestId('diagnostics');
  await card.scrollIntoViewIfNeeded();

  // Assert
  await expect(card.getByRole('heading')).toContainText('Relatório de problema');
  await expect(card.getByTestId('export-logs')).toHaveText('Exportar logs');

  // Act
  await card.getByText('Avançado').click();

  // Assert
  await expect(card.getByText('Incluir os endereços IP completos (só se o desenvolvedor pedir)')).toBeVisible();
});
