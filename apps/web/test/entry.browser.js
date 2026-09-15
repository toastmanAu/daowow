/* Run with the Playwright browser tool's filename option against the local preview server. */
async (page) => {
  await page.goto("http://127.0.0.1:8931/entry.html");
  await page.getByRole("button", { name: "10 tickets", exact: true }).click();
  if (await page.locator("#principal").textContent() !== "1,000 CKB") throw Error("Incorrect principal");
  await page.locator("#review").click();
  if (await page.locator("#review-quantity").textContent() !== "10") throw Error("Stale review");
  for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    if (!await page.evaluate(() => !!document.activeElement.closest("#review-dialog"))) throw Error("Focus escaped dialog");
  }
  await page.keyboard.press("Escape");
  if (await page.locator("#review-dialog").isVisible()) throw Error("Escape failed");
  if (!await page.locator("#review").evaluate(el => el === document.activeElement)) throw Error("Focus not restored");
  for (const value of ["", "0", "101", "1.5", "1e1"]) {
    await page.locator("#quantity").fill(value);
    if (await page.locator("#review").isEnabled()) throw Error("Invalid quantity enabled review");
    if (await page.locator("#principal").textContent() !== "—") throw Error("Stale invalid quote");
  }
  await page.getByRole("button", { name: "1 ticket", exact: true }).click();
  if (await page.locator("#decrease").isEnabled()) throw Error("Lower boundary");
  await page.locator("#quantity").fill("100");
  if (await page.locator("#increase").isEnabled()) throw Error("Upper boundary");
  await page.locator("#wallet").click();
  if (!await page.locator("#wallet-dialog").isVisible()) throw Error("Missing wallet information");
  await page.keyboard.press("Escape");
  const viewports = [];
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.evaluate(() => ({
      width: innerWidth, scroll: document.documentElement.scrollWidth,
      textBottom: document.querySelector(".studio-copy").getBoundingClientRect().bottom,
      artTop: document.querySelector(".ball-stage").getBoundingClientRect().top,
    }));
    if (box.scroll > width) throw Error("Horizontal overflow");
    if (width <= 800 && box.artTop < box.textBottom) throw Error("Artwork overlaps copy");
    viewports.push(width);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (await page.locator(".ball-stage").evaluate(el => getComputedStyle(el).animationName) !== "none") throw Error("Reduced motion ignored");
  await page.getByRole("button", { name: "5 tickets", exact: true }).click();
  await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
  return { passed: true, viewports, checks: "selection, validation, review, dialogs, keyboard, overflow, artwork layout, reduced motion" };
}
