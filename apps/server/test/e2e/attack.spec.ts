import fs from "node:fs";
import path from "node:path";
import {
  adminApi,
  adminState,
  expect,
  liveLink,
  test,
  uid,
  waitPlaying,
} from "./fixtures.js";

// The gate (fixtures.ts) starts it with fresh rate-limit buckets and, for the next test, empties
// the buckets this flood filled and ends the alert if an assertion failed before the panel did.
test("a flood of invalid join links is detected, turns on the browser check, and real viewers still join", { tag: "@media" }, async ({
  browser,
  browserName,
  baseURL,
}) => {
  test.skip(browserName !== "chromium", "checked on Chromium");
  test.setTimeout(180_000);
  const link = await liveLink();
  // The always-on light check (the default) is switched off here, so this test sees the shield turn it on.
  const settings = (await adminState()).security.settings;
  await adminApi("PUT", "/api/security", {
    ...settings,
    requireBrowserCheck: false,
  });
  const before = await adminState();
  expect(before.security).toMatchObject({
    threat: "normal",
    browserCheck: 0,
  });

  // Two viewers open the link before the attack (they hold a join ticket).
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(link);
  await expect(pageA).toHaveURL(/\/join$/);
  await expect(pageA.locator("#check")).toBeHidden();
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(link);
  await expect(pageB).toHaveURL(/\/join$/);

  // Flood: ~100 requests/s of made-up links for a few seconds.
  let flooding = true;
  let sent = 0;
  const flood = (async () => {
    while (flooding && sent < 3000) {
      await Promise.all(
        Array.from({ length: 30 }, () =>
          fetch(`${baseURL}/join/not-a-real-link-${sent++}`)
            .then((r) => r.arrayBuffer())
            .catch(() => null),
        ),
      );
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  await expect
    .poll(async () => (await adminState()).security.threat, {
      timeout: 30_000,
      intervals: [500],
    })
    .toBe("attack");
  flooding = false;
  await flood;
  const during = await adminState();
  expect(during.warningCodes[0]).toMatchObject({
    code: "warn.attackDetected",
  });
  expect(during.security.browserCheck).toBe(2);
  expect(during.security.reasonCode).toMatch(/^attack\.reason\./);

  // The panel shows it in the Protection card.
  const env = JSON.parse(
    fs.readFileSync(path.join("test-results", "e2e-env.json"), "utf8"),
  ) as { adminLoginUrl: string };
  const adminCtx = await browser.newContext();
  const panel = await adminCtx.newPage();
  await panel.goto(env.adminLoginUrl);
  await expect(panel.getByTestId("threat")).toHaveAttribute(
    "data-threat",
    "attack",
  );
  await expect(panel.getByTestId("browser-check")).toHaveAttribute(
    "data-level",
    "2",
  );
  await expect(panel.locator(".warn").first()).toContainText(
    "Possible attack",
  );

  // Viewer A loaded the page before the check was on: the server asks for it, the page solves and retries.
  await pageA.fill("#nickname", uid("before"));
  const joinA = pageA.waitForResponse(
    (r) => r.url().endsWith("/api/join") && r.status() === 403,
  );
  await pageA.click("#join");
  expect(((await (await joinA).json()) as { code: string }).code).toBe(
    "viewer.err.checkRequired",
  );
  await expect(pageA).toHaveURL(/\/watch$/, { timeout: 20_000 });
  await waitPlaying(pageA);

  // Viewer B reloads the join page: it solves the check proactively ("Checking your browser…").
  const challenge = pageB.waitForResponse((r) =>
    r.url().endsWith("/api/join/challenge"),
  );
  await pageB.reload();
  expect(await (await challenge).json()).toMatchObject({ required: true });
  await pageB.fill("#nickname", uid("during"));
  const request = pageB.waitForRequest(
    (r) => r.url().endsWith("/api/join") && r.method() === "POST",
  );
  await pageB.click("#join");
  const body = (await request).postDataJSON() as {
    pow?: { solution?: { counter: number; time?: number } };
  };
  expect(body.pow?.solution?.counter).toBeGreaterThan(0);
  // How long the stronger attack-level check took (about 0.3 s on a fast desktop, up to ~2 s on
  // slow machines, docs/SECURITY_RESEARCH.md): recorded, not asserted. A shared CI runner's
  // speed is not what this test checks; the level is (counter > 0 at level 2).
  test.info().annotations.push({
    type: "pow-ms",
    description: String(body.pow?.solution?.time ?? "unknown"),
  });
  await expect(pageB).toHaveURL(/\/watch$/);

  // The streamer ends the alert from the panel.
  await panel.getByTestId("end-alert").click();
  await expect(panel.getByTestId("threat")).toHaveAttribute(
    "data-threat",
    "normal",
  );
  expect((await adminState()).security).toMatchObject({
    threat: "normal",
    browserCheck: 0,
    tightened: false,
  });

  await adminApi("PUT", "/api/security", settings);
  expect((await adminState()).security.browserCheck).toBe(1);
  await ctxA.close();
  await ctxB.close();
  await adminCtx.close();
});
