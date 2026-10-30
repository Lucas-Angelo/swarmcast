import { adminApi, expect, join, test, uid } from './fixtures.js';

// "Your page" end to end: the panel saves the branding on the real server (BR2 routes) and the
// viewer's join and watch pages show it (BR4). Fake data only.

test.describe('Your page on the viewer pages', () => {
  test('a saved page shows on the join and watch pages, with safe links', { tag: '@ui' }, async ({ browser }) => {
    await adminApi('PUT', '/api/branding', {
      enabled: true,
      name: 'Ana Plays',
      tagline: 'Chill games and chat every Friday',
      about: 'Hi! I stream cozy games.',
      tags: ['cozy'],
      links: [{ label: 'YouTube', url: 'https://youtube.com/@ana' }],
      support: { enabled: true, label: 'support', mode: 'link', url: 'https://ko-fi.com/ana' },
      theme: { preset: 'ocean', corners: 'round' },
      preview: { enabled: false },
      showCredit: true,
    });
    const { context, page } = await join(browser, uid('brand'));
    await expect(page.locator('.sc-brand-name')).toHaveText('Ana Plays');
    const link = page.locator('a.sc-brand-link');
    await expect(link).toHaveAttribute('href', 'https://youtube.com/@ana');
    await expect(link).toHaveAttribute('target', '_blank');
    expect((await link.getAttribute('rel'))!.split(' ').sort()).toEqual(['nofollow', 'noopener', 'noreferrer']);
    await expect(page.locator('.sc-brand-support')).toHaveAttribute('href', 'https://ko-fi.com/ana');
    await adminApi('POST', '/api/branding/reset', {});
    await context.close();
  });
});
