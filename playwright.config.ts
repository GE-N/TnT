import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: {timeout: 15_000},
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    headless: true,
    viewport: {width: 1280, height: 800},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
