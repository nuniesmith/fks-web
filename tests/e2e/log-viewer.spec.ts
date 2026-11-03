import { test, expect } from "@playwright/test";
import { installHome } from "./fixtures/home";

/**
 * The log viewer and a stream that ends (a stopped container, a dropped
 * connection): the spawner re-sends the tail on every connect, so the
 * browser's automatic reconnect used to append the same lines every few
 * seconds. It now stops, says so, and reconnects only on request, fresh.
 */
test("a finished stream is shown once, and Reconnect starts it fresh", async ({ page }) => {
  await installHome(page);
  let connects = 0;
  await page.route(
    (url) => /^\/api\/spawner\/container\/[^/]+\/logs$/.test(url.pathname),
    async (route) => {
      connects++;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: "event: log\ndata: experiment 1: DO NOT PASTE\n\nevent: log\ndata:   U1 ok   dataset complete\n\n",
      });
    },
  );
  await page.goto("/tasks");
  await page.getByRole("button", { name: "Logs", exact: true }).first().click();
  const logs = page.locator("section.logs");
  await expect(logs.locator(".line")).toHaveCount(2);
  await expect(logs.getByTestId("log-ended")).toBeVisible();
  // The browser would have reconnected (and re-appended) by now; it doesn't.
  await page.waitForTimeout(4000);
  await expect(logs.locator(".line")).toHaveCount(2);
  expect(connects).toBe(1);
  await logs.getByRole("button", { name: "Reconnect" }).click();
  await expect.poll(() => connects).toBe(2);
  await expect(logs.locator(".line")).toHaveCount(2);
});
