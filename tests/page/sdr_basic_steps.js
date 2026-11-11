// Basic SDR flow: board 1 receives (SF7), board 2 loads the SDR firmware from the page and sends 4 frames.
module.exports = async function steps(page, OUT, errors, browser) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const states = () => page.$$eval(".card .state", (e) => e.map((x) => x.textContent));
  await sleep(2500);
  console.log("after connect:", await states());
  const cards = await page.$$("section.card");
  // 1. load the firmware into board 2 from the page (ROM loader over the fake port's signals)
  for (const k of [1, 0]) {
    await (await cards[k].$(".load")).click();
    for (let i = 0; i < 40; i++) { await sleep(250); const s = (await states())[k]; if (/^ready|failed|does not/.test(s)) break; }
    console.log(`after Load firmware on board ${k + 1}:`, (await states())[k]);
  }
  // 2. board 1 receives, board 2 transmits 4 frames
  const set = async (card, sel, v) => card.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, v);
  await set(cards[0], ".rx-gain", process.env.GAIN || "20");
  if (process.env.PPM_RX) await set(cards[0], ".ppm", process.env.PPM_RX);
  if (process.env.PPM_TX) await set(cards[1], ".ppm", process.env.PPM_TX);
  await (await cards[0].$(".rx-start")).click();
  await sleep(1500);
  await (await cards[1].$('.tabs button[data-mode="tx"]')).click();
  await set(cards[1], ".tx-count", "4");
  await set(cards[1], ".tx-payload", "WEB UI TEST");
  await (await cards[1].$(".tx-send")).click();
  await sleep(9000);
  await page.screenshot({ path: `${OUT}/page-light.png`, fullPage: true });
  const rows = await cards[0].$$eval(".rx-list tr", (r) => r.map((x) => Array.from(x.cells).map((c) => c.textContent).join(" | ")));
  console.log("received rows:\n  " + rows.join("\n  "));
  console.log("rx stats:", await cards[0].$eval(".rx-stats", (e) => e.textContent));
  await (await cards[0].$(".rx-stop")).click();
  await sleep(1500);
  console.log("log:\n  " + (await page.$eval("#log", (e) => e.innerText)).split("\n").slice(-14).join("\n  "));
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.setViewport({ width: 390, height: 900 });
  await sleep(300);
  await page.screenshot({ path: `${OUT}/page-dark-phone.png`, fullPage: false });
  console.log("horizontal overflow at 390 px:", await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(0);
};
