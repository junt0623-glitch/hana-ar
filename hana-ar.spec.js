/**
 * 花をいける — Playwright回帰テスト（自己完結版）
 * 実ブラウザ(Chromium)＋疑似カメラで、来館者フロー・メーカーモード・器適合ロジック・
 * 合成保存・オフライン動作までを自動検証する。
 *
 * 実行: node tests/hana-ar.spec.js
 * リポジトリ直下の hana-ar.html を対象に、内蔵の静的サーバー(Node標準http)で配信して検証する。
 * 外部npmパッケージはplaywright本体のみ（単一ファイル原則をテスト側でも踏襲）。
 *
 * GitHub Actionsからは workflow_dispatch で起動する想定（.github/workflows/test.yml）。
 *
 * 疑似カメラ: Chromiumの --use-fake-device-for-media-stream で疑似映像を供給。
 * 実機のガラス反射・照明条件・タッチの微妙な感触などは自動テスト対象外。
 * 別途「実機検証チェックリスト.md」で人手検証すること。
 */
const { chromium } = require("playwright");
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8931;
const ROOT = path.resolve(__dirname, "..");           // リポジトリ直下(hana-ar.htmlの場所)
const HTML_FILE = process.env.HANA_AR_FILE || "hana-ar.html";

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split("?")[0];
      const file = urlPath === "/" ? HTML_FILE : urlPath.replace(/^\//, "");
      const full = path.join(ROOT, file);
      fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found: " + file); return; }
        const ext = path.extname(full);
        const type = ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
      });
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

const BASE = `http://localhost:${PORT}/${HTML_FILE}`;
const results = [];
let browser, context, httpServer;

async function bt(id, name, fn) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", msg => { if (msg.type() === "error") errors.push("console.error: " + msg.text()); });
  try {
    await fn(page);
    if (errors.length) throw new Error("JS errors during test: " + errors.join(" | "));
    results.push({ id, name, ok: true });
  } catch (e) {
    results.push({ id, name, ok: false, error: e.message });
  } finally {
    await page.close();
  }
}

async function run() {
  httpServer = await startServer();

  browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["camera"],
  });

  await bt("bt01", "存在しない作品IDでエラー表示", async (page) => {
    await page.goto(`${BASE}?work=ZZZ`);
    const title = await page.textContent("#wTitle");
    assert(title.includes("見つかりません"), "エラー文言が出ていない: " + title);
    const disabled = await page.getAttribute("#startBtn", "disabled");
    assert(disabled !== null, "startBtnがdisabledでない");
  });

  await bt("bt02", "作品情報画面: W001が正しく表示される", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.waitForSelector("#wTitle");
    const title = await page.textContent("#wTitle");
    const vessel = await page.textContent("#wVessel");
    assert.strictEqual(title.trim(), "青花梅瓶");
    assert.strictEqual(vessel.trim(), "梅瓶");
  });

  await bt("bt03", "カメラ起動でstage画面に遷移", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#stage.active", { timeout: 5000 });
    await page.waitForFunction(() => {
      const v = document.querySelector("#video");
      return v && v.readyState >= 2 && v.videoWidth > 0;
    }, undefined, { timeout: 10000 });
    const w = await page.evaluate(() => document.querySelector("#video").videoWidth);
    assert(w > 0, "video要素にカメラ映像が来ていない");
  });

  await bt("bt04", "器適合: W001は梅・水仙のみサムネイル表示", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb", { timeout: 5000 });
    const names = await page.$$eval("#thumbs .thumb .nm", els => els.map(e => e.textContent.trim()).sort());
    assert.deepStrictEqual(names, ["水仙", "梅"].sort(), "got: " + JSON.stringify(names));
  });

  await bt("bt05", "器適合: 真の様式(松竹梅)はW001に出ない", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    const names = await page.$$eval("#thumbs .thumb .nm", els => els.map(e => e.textContent.trim()));
    assert(!names.includes("松竹梅"), "松竹梅が出てしまっている");
  });

  await bt("bt06", "器適合: W003は蓮のみ表示", async (page) => {
    await page.goto(`${BASE}?work=W003`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    const names = await page.$$eval("#thumbs .thumb .nm", els => els.map(e => e.textContent.trim()));
    assert.deepStrictEqual(names, ["蓮"]);
  });

  await bt("bt07", "花サムネイルタップで配置される", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForSelector("#layer .bloom", { timeout: 3000 });
    const count = await page.$$eval("#layer .bloom", els => els.length);
    assert.strictEqual(count, 1);
  });

  await bt("bt08", "ドラッグ操作で花の座標が変化する", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForSelector("#layer .bloom");
    const before = await page.evaluate(() => document.querySelector("#layer .bloom")._state.x);
    const box = await page.$eval("#layer .bloom", el => {
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 40, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => document.querySelector("#layer .bloom")._state.x);
    assert(Math.abs(after - before) > 10, `移動していない before=${before} after=${after}`);
  });

  await bt("bt09", "花を複数配置できる(季節タブ切替を含む)", async (page) => {
    await page.goto(`${BASE}?work=W002`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForTimeout(150);
    const seasonTabs = await page.$$("#seasonTabs .tab");
    assert(seasonTabs.length >= 2, "季節タブが複数無いとテスト続行不可, got " + seasonTabs.length);
    await seasonTabs[1].click();
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForTimeout(150);
    const count = await page.$$eval("#layer .bloom", els => els.length);
    assert.strictEqual(count, 2, "配置数が2ではない: " + count);
  });

  await bt("bt10", "🗑ボタン→モーダル確認→花が消える", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForSelector("#layer .bloom");
    await page.click("#clearBtn");
    await page.waitForSelector("#modalBg.active", { timeout: 3000 });
    await page.click("#mOk");
    await page.waitForFunction(() => document.querySelectorAll("#layer .bloom").length === 0, undefined, { timeout: 3000 });
  });

  await bt("bt11", "シャッターで画像ダウンロードが発生する", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForSelector("#layer .bloom");
    await page.waitForFunction(() => {
      const v = document.querySelector("#video"); return v && v.videoWidth > 0;
    }, undefined, { timeout: 10000 });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 8000 }),
      page.click("#shutter"),
    ]);
    const fname = download.suggestedFilename();
    assert(fname.startsWith("hana_W001_"), "ファイル名不正: " + fname);
  });

  await bt("bt12", "外部リクエストが発生しない", async (page) => {
    const external = [];
    page.on("request", req => {
      const url = req.url();
      if (!url.startsWith(`http://localhost:${PORT}`) && !url.startsWith("data:") && !url.startsWith("blob:")) {
        external.push(url);
      }
    });
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForTimeout(500);
    assert.strictEqual(external.length, 0, "外部リクエスト検出: " + JSON.stringify(external));
  });

  await bt("bt13", "オフラインでも動作する(初回読込後)", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await context.setOffline(true);
    try {
      await page.click("#thumbs .thumb");
      await page.waitForSelector("#layer .bloom", { timeout: 3000 });
    } finally {
      await context.setOffline(false);
    }
  });

  await bt("bt14", "メーカーモード初期表示(作品3件・W001適合花2件)", async (page) => {
    await page.goto(`${BASE}?mode=maker`);
    await page.waitForSelector("#maker.active");
    const opts = await page.$$eval("#workSelect option", els => els.length);
    assert.strictEqual(opts, 3);
    await page.waitForSelector("#makerThumbs .thumb");
    const thumbs = await page.$$eval("#makerThumbs .thumb", els => els.length);
    assert.strictEqual(thumbs, 2, "W001の適合花は2件のはず, got " + thumbs);
  });

  await bt("bt15", "メーカーモードでQRコードが生成される", async (page) => {
    await page.goto(`${BASE}?mode=maker`);
    await page.waitForSelector("#makerThumbs .thumb");
    await page.click("#makerThumbs .thumb");
    await page.click("#makeQRBtn");
    await page.waitForSelector("#qrSheet.active", { timeout: 3000 });
    const hasPixels = await page.evaluate(() => {
      const cv = document.querySelector("#qrCanvas");
      const ctx = cv.getContext("2d");
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return dark;
    });
    assert(hasPixels > 100, "QRらしき黒画素が少なすぎる: " + hasPixels);
  });

  await bt("bt16", "メーカーQRのURLパラメータが正しい", async (page) => {
    await page.goto(`${BASE}?mode=maker`);
    await page.waitForSelector("#makerThumbs .thumb");
    await page.click("#makerThumbs .thumb");
    await page.click("#makeQRBtn");
    await page.waitForSelector("#qrSheet.active");
    const url = await page.textContent("#qUrl");
    assert(/\?work=W001&f=F0(12|45)&s=1/.test(url), "URL形式不正: " + url);
  });

  await bt("bt17", "プリセットURL(?work=&f=&s=)で花が自動配置される", async (page) => {
    await page.goto(`${BASE}?work=W001&f=F012&s=1.3`);
    await page.click("#startBtn");
    await page.waitForSelector("#layer .bloom", { timeout: 5000 });
    const scale = await page.evaluate(() => document.querySelector("#layer .bloom")._state.scale);
    assert(Math.abs(scale - 1.3) < 0.01, "scale不正: " + scale);
  });

  await bt("bt18", "不適合プリセットは拒否されトースト表示", async (page) => {
    await page.goto(`${BASE}?work=W001&f=F031&s=1.0`);
    await page.click("#startBtn");
    await page.waitForTimeout(600);
    const count = await page.$$eval("#layer .bloom", els => els.length);
    assert.strictEqual(count, 0, "不適合花が配置されてしまっている");
  });

  await browser.close();
  httpServer.close();

  console.log("\n=== hana-ar.html Playwright回帰テスト ===");
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.ok) { console.log(` ✓ ${r.id} ${r.name}`); pass++; }
    else { console.log(` ✗ ${r.id} ${r.name} — ${r.error}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
  process.exitCode = fail ? 1 : 0;
}

run().catch(e => { console.error("FATAL:", e); process.exitCode = 1; });
