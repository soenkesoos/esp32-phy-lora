// SDR flow in the page: auto crystal correction on SF9, then SF11. Runs after the shared setup of test_page.js has loaded the page.
module.exports = async function steps(page, OUT, errors, browser) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const states = () => page.$$eval(".card .state", (e) => e.map((x) => x.textContent));
  for (let i = 0; i < 30; i++) { await sleep(500); const s = await states(); if (s.length === 2 && s.every((x) => /ready|no known|failed/.test(x))) break; }
  console.log("after connect:", await states());
  const cards = await page.$$("section.card");
  const set = async (card, sel, v) => card.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); }, v);
  const rows = () => cards[0].$$eval(".rx-list tr", (r) => r.map((x) => Array.from(x.cells).map((c) => c.textContent).join(" | ")));
  const ppm2 = () => cards[1].$eval(".ppm", (e) => e.value);
  const waitIdle = async (k) => { for (let i = 0; i < 400; i++) { await sleep(250); if (await cards[k].$eval(".tx-send", (b) => !b.disabled)) return; } };
  await (await cards[1].$('.tabs button[data-mode="tx"]')).click();
  for (const [sf, n, interval] of [[9, 3, 1], [11, 3, 2.5]]) {
    if (await cards[0].$eval(".rx-stop", (b) => !b.disabled)) { await (await cards[0].$(".rx-stop")).click(); await sleep(1500); }
    await set(cards[0], ".rx-sf", String(sf));
    await set(cards[1], ".tx-sf", String(sf));
    await (await cards[0].$(".rx-start")).click();
    await sleep(2500);
    console.log(`SF${sf}: sending ${n} frames; board 2 crystal correction before: ${await ppm2()} ppm`);
    await set(cards[1], ".tx-count", String(n)); await set(cards[1], ".tx-interval", String(interval));
    await set(cards[1], ".tx-payload", `SF${sf} TEST`);
    await (await cards[1].$(".tx-send")).click();
    await waitIdle(1);
    await sleep(sf >= 11 ? 5000 : 3000);
    console.log(`  board 2 crystal correction after: ${await ppm2()} ppm; received so far:\n    ` + (await rows()).join("\n    "));
  }
  console.log("rx stats:", await cards[0].$eval(".rx-stats", (e) => e.textContent));
  await page.screenshot({ path: `${OUT}/page-sdr-range.png`, fullPage: true });
  console.log("log:\n  " + (await page.$eval("#log", (e) => e.innerText)).split("\n").slice(-22).join("\n  "));
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(0);
};
