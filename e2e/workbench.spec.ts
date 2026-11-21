import {askGuestCheckout, edgeRegressionWorkspace, expect, openApp, seedWorkspace, test, unusedConnectionsWorkspace} from './support.js';

test('the app loads and the canvas renders', async ({page, workbench}) => {
  await openApp(page, workbench);
  await expect(page.getByRole('button', {name: 'Manage workspace'})).toContainText('Untitled workspace');
  await expect(page.getByTestId('sequence-scenario-name')).toHaveText('No scenarios');
  await expect(page.getByRole('toolbar', {name: 'Canvas zoom'})).toBeVisible();
  await expect(page.getByTestId('ai-flow-field')).toHaveAttribute('placeholder', 'Ask AI');
});

test('Ask AI creates a flow and the canvas shows its screens and connection', async ({page, workbench}) => {
  await openApp(page, workbench);
  await askGuestCheckout(page);
});

test('info, Versions, Results, and Settings share one right-hand panel, and Settings opens from the workspace menu', async ({page, workbench}) => {
  await openApp(page, workbench);
  await askGuestCheckout(page);
  await page.getByTestId('knowledge-info-button').click();
  await expectSoleSheet(page, 'knowledge-sheet');
  await expect(page.getByTestId('knowledge-sheet')).toContainText('Scenario details');

  await expect(page.getByTestId('ai-versions')).toBeVisible({timeout: 20_000});
  await page.getByTestId('ai-versions').click();
  await expectSoleSheet(page, 'ai-versions-sheet');
  await expect(page.getByRole('heading', {name: 'Versions'})).toBeVisible();

  await page.getByTestId('results-pill').click();
  await expectSoleSheet(page, 'results-sheet');
  await expect(page.getByTestId('results-empty')).toContainText('No results yet');

  await page.getByRole('button', {name: 'Manage workspace'}).click();
  await page.getByTestId('workspace-settings').click();
  await expectSoleSheet(page, 'ai-settings');
  await expect(page.getByRole('heading', {name: 'Settings'})).toBeVisible();
});

test('deleting a scenario removes the edges only that scenario listed', async ({page, workbench, request}) => {
  await seedWorkspace(request, workbench, edgeRegressionWorkspace());
  await openApp(page, workbench);
  await expect(page.getByRole('button', {name: 'Manage workspace'})).toContainText('Edge regression');
  await expect(page.getByRole('img', {name: 'Connection Home to Details'})).toBeVisible();
  await expect(page.getByRole('img', {name: 'Connection Home to Only for dropped'})).toBeVisible();

  await page.getByRole('button', {name: 'Scenarios'}).click();
  await page.getByRole('button', {name: 'More actions for Only for dropped'}).click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();

  await expect(page.getByRole('img', {name: 'Connection Home to Only for dropped'})).toHaveCount(0);
  await expect(page.getByRole('img', {name: 'Connection Home to Details'})).toBeVisible();
  await expect(page.getByRole('article', {name: 'Screen Home'})).toBeVisible();
  await expect(page.getByRole('article', {name: 'Screen Details'})).toBeVisible();
  await expect(page.getByRole('article', {name: 'Screen Only for dropped'})).toBeVisible();
  await expect(page.getByRole('status').filter({hasText: 'Only for dropped'})).toContainText('deleted');
});

test('unused connections can be removed from the empty-canvas menu and undone', async ({page, workbench, request}) => {
  await seedWorkspace(request, workbench, unusedConnectionsWorkspace());
  await openApp(page, workbench);
  await expect(page.getByRole('img', {name: 'Connection Home to Profile'})).toBeVisible();
  await expect(page.getByRole('img', {name: 'Connection Home to Details'})).toBeVisible();

  const surface = page.locator('.canvas-surface');
  const box = await surface.boundingBox();
  if (!box) throw new Error('The canvas surface is not visible.');
  await surface.click({button: 'right', position: {x: box.width * 0.72, y: box.height * 0.82}});
  await page.getByRole('menuitem', {name: 'Unused connections…'}).click();

  const sheet = page.getByTestId('unused-connections-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('1 will be removed');
  await expect(sheet).toContainText('Home → Profile');
  await expect(sheet).not.toContainText('Home → Details');
  await sheet.getByRole('button', {name: 'Remove'}).click();

  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('img', {name: 'Connection Home to Profile'})).toHaveCount(0);
  await expect(page.getByRole('img', {name: 'Connection Home to Details'})).toBeVisible();
  await expect(page.getByRole('article', {name: 'Screen Profile'})).toBeVisible();
  await expect(page.getByTestId('unused-connections-toast')).toContainText('1 unused connection removed');
  await page.getByRole('button', {name: 'Undo unused connection removal'}).click();

  await expect(page.getByTestId('unused-connections-toast')).toHaveCount(0);
  await expect(page.getByRole('img', {name: 'Connection Home to Profile'})).toBeVisible();
  await expect(page.getByRole('img', {name: 'Connection Home to Details'})).toBeVisible();
});

async function expectSoleSheet(page: import('@playwright/test').Page, testId: string) {
  await expect(page.locator('[data-side-sheet]')).toHaveAttribute('data-testid', testId);
}
