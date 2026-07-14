import { test, expect } from '@playwright/test';

// Every static page on the site, with the bits that should always be true.
const pages = [
  { path: '/', title: 'Home', heading: "Hi, I'm Arjan." },
  { path: '/working', title: 'Working', heading: 'Working' },
  { path: '/projects', title: 'Doing', heading: 'Doing' },
  { path: '/blog', title: 'Writing', heading: 'Writing' },
  { path: '/books', title: 'Reading', heading: 'Reading' },
  { path: '/films', title: 'Watching', heading: 'Watching' },
  { path: '/travels', title: 'Places', heading: 'Places' },
];

for (const { path, title, heading } of pages) {
  test(`${path} loads`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.ok()).toBeTruthy();
    await expect(page).toHaveTitle(`${title} · aselling`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.locator('.site-footer')).toBeVisible();
  });
}

test('blog post page renders a post', async ({ page }) => {
  const response = await page.goto('/blog/breakaway');
  expect(response?.ok()).toBeTruthy();
  await expect(page).toHaveTitle('Breakaway · aselling');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Breakaway');
  await expect(page.locator('.prose')).not.toBeEmpty();
});

test('nav links navigate to each page', async ({ page }) => {
  await page.goto('/');

  const internalPages = pages.filter((p) => p.path !== '/');
  for (const { path, heading } of internalPages) {
    await page.locator(`nav a[href="${path}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${path}/?$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
});

test('blog index links to the post and shows the subscribe form', async ({ page }) => {
  await page.goto('/blog');
  await expect(page.locator('#subscribe-form')).toBeVisible();
  await page.getByRole('link', { name: 'Breakaway' }).click();
  await expect(page).toHaveURL(/\/blog\/breakaway\/?$/);
});

test('subscribe form validates email before sending', async ({ page }) => {
  await page.goto('/blog');
  await page.locator('#subscribe-email').fill('not-an-email');
  await page.locator('#subscribe-submit').click();
  await expect(page.locator('#subscribe-status')).toHaveText('enter a valid email address');
});

test('places map renders with the legend', async ({ page }) => {
  await page.goto('/travels');
  await expect(page.locator('#map.leaflet-container')).toBeVisible();
  await expect(page.locator('.map-legend')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filter map markers' }).getByRole('checkbox')).toHaveCount(5);
});
