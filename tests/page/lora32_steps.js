// The LORA32 part of the browser test: runs after the shared setup of test_page.js (lines 1-50) has loaded the page.
module.exports = async function steps(page, OUT, errors, browser) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const states = () => page.$$eval(".card .state", (e) => e.map((x) => x.textContent));
  for (let i = 0; i < 30; i++) { await sleep(500); const s = await states(); if (s.length === 2 && s.every((x) => /listening|failed|no known/.test(x))) break; }
  console.log("after connect:", await states());
  const cards = await page.$$("section.card");
  const set = async (card, sel, v) => card.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input")); }, v);
  const rows = (k) => cards[k].$$eval(".m-list tr", (r) => r.map((x) => Array.from(x.cells).map((c) => c.textContent).join(" | ")));
  await set(cards[0], ".m-payload", "BROADCAST"); await set(cards[0], ".m-count", "3");
  await (await cards[0].$(".m-send")).click();
  await sleep(6000);
  await set(cards[1], ".m-payload", "TO NODE 1"); await set(cards[1], ".m-dest", "1");
  await (await cards[1].$(".m-send")).click();
  await sleep(4000);
  console.log("board 2 received:\n  " + (await rows(1)).join("\n  "));
  console.log("board 1 received:\n  " + (await rows(0)).join("\n  "));
  console.log("board 1 stats:", await cards[0].$eval(".m-stats", (e) => e.textContent));
  await page.screenshot({ path: `${OUT}/page-lora32.png`, fullPage: true });
  await (await cards[1].$(".load")).click();
  for (let i = 0; i < 40; i++) { await sleep(250); if (/ready|failed|no known/.test((await states())[1])) break; }
  console.log("board 2 after Load SDR firmware:", (await states())[1], "| receive tab visible:", await cards[1].$eval(".body.rx", (e) => !e.classList.contains("hidden")));
  await (await cards[1].$(".reboot")).click();
  for (let i = 0; i < 40; i++) { await sleep(250); if (/listening|failed|no known/.test((await states())[1])) break; }
  console.log("board 2 after Reboot:", (await states())[1]);
  console.log("log:\n  " + (await page.$eval("#log", (e) => e.innerText)).split("\n").slice(-16).join("\n  "));
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  process.exit(0);
};
