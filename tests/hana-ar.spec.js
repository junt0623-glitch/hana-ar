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
      // フル版Chromiumはfaviconを自動取得し404がconsole.errorに乗るため空応答を返す（headless shellでは要求されない）
      if (urlPath === "/favicon.ico") { res.writeHead(204); res.end(); return; }
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

// アプリの難読化トークン（?d=）と同一仕様のエンコード/デコード（XOR＋base64url）
const OBF_KEY = "hana-ar-2026";
function obEnc(s) {
  const b = Buffer.from(s, "utf8");
  for (let i = 0; i < b.length; i++) b[i] ^= OBF_KEY.charCodeAt(i % OBF_KEY.length);
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function obDec(t) {
  t = t.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const b = Buffer.from(t, "base64");
  for (let i = 0; i < b.length; i++) b[i] ^= OBF_KEY.charCodeAt(i % OBF_KEY.length);
  return b.toString("utf8");
}

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
    // ローカル/コンテナ環境でPlaywright同梱版と異なるChromiumを使う場合のみ指定（CIでは未設定のまま）
    executablePath: process.env.HANA_AR_CHROMIUM || undefined,
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

  await bt("bt04", "器適合: W001の冬タブは梅・水仙・蝋梅のみサムネイル表示", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb", { timeout: 5000 });
    // W001は夏(石榴花)・秋(桂花)・冬(梅/水仙/蝋梅)が適合し既定は夏タブのため、冬タブを選んで検証する
    await page.click('#seasonTabs .tab[data-season="winter"]');
    await page.waitForSelector("#thumbs .thumb");
    const names = await page.$$eval("#thumbs .thumb .nm", els => els.map(e => e.textContent.trim()).sort());
    assert.deepStrictEqual(names, ["水仙", "梅", "蝋梅"].sort(), "got: " + JSON.stringify(names));
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
    // ピクセル判定になったため、確実に不透明な「茎の根元」（アンカーx・高さ90%）を掴む
    const box = await page.$eval("#layer .bloom", el => {
      const r = el.getBoundingClientRect(); const a = el._state.anchor;
      return { x: r.x + r.width * a.x, y: r.y + r.height * 0.9 };
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

  await bt("bt14", "メーカーモード初期表示(作品3件・W001適合花9件)", async (page) => {
    await page.goto(`${BASE}?mode=maker`);
    await page.waitForSelector("#maker.active");
    const opts = await page.$$eval("#workSelect option", els => els.length);
    assert.strictEqual(opts, 3);
    await page.waitForSelector("#makerThumbs .thumb");
    // メーカーは季節を跨いで適合花を全表示。
    // W001: 梅・水仙・蝋梅・石榴花・桂花＋春4種(梅(残春)・海棠・蘭・桃)の9件
    const thumbs = await page.$$eval("#makerThumbs .thumb", els => els.length);
    assert.strictEqual(thumbs, 9, "W001の適合花は9件のはず, got " + thumbs);
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

  await bt("bt16", "メーカーQRのURLが難読化トークン(?d=)で正しい内容を持つ", async (page) => {
    await page.goto(`${BASE}?mode=maker`);
    await page.waitForSelector("#makerThumbs .thumb");
    await page.click("#makerThumbs .thumb");
    await page.click("#makeQRBtn");
    await page.waitForSelector("#qrSheet.active");
    const url = await page.textContent("#qUrl");
    assert(/\?d=[A-Za-z0-9_-]+$/.test(url), "トークン形式でない: " + url);
    const token = url.split("?d=")[1];
    const plain = obDec(token);
    assert(/^work=W001&f=F0(21|22|23)&s=1/.test(plain), "復号内容不正: " + plain);
  });

  await bt("bt17", "プリセットURL(?work=&f=&s=)で花が自動配置される", async (page) => {
    await page.goto(`${BASE}?work=W001&f=F023&s=1.3`);
    await page.click("#startBtn");
    await page.waitForSelector("#layer .bloom", { timeout: 5000 });
    const scale = await page.evaluate(() => document.querySelector("#layer .bloom")._state.scale);
    assert(Math.abs(scale - 1.3) < 0.01, "scale不正: " + scale);
  });

  await bt("bt18", "不適合プリセットは拒否されトースト表示", async (page) => {
    await page.goto(`${BASE}?work=W001&f=F015&s=1.0`);
    await page.click("#startBtn");
    await page.waitForTimeout(600);
    const count = await page.$$eval("#layer .bloom", els => els.length);
    assert.strictEqual(count, 0, "不適合花が配置されてしまっている");
  });

  await bt("bt19", "難読化トークンURL(?d=)でも花が自動配置される", async (page) => {
    const token = obEnc("work=W001&f=F023&s=1.3");
    await page.goto(`${BASE}?d=${token}`);
    await page.click("#startBtn");
    await page.waitForSelector("#layer .bloom", { timeout: 5000 });
    const scale = await page.evaluate(() => document.querySelector("#layer .bloom")._state.scale);
    assert(Math.abs(scale - 1.3) < 0.01, "scale不正: " + scale);
  });

  await bt("bt20", "器の口線で線より下の花がクリップされる", async (page) => {
    await page.goto(`${BASE}?work=W001`);
    await page.click("#startBtn");
    await page.waitForSelector("#thumbs .thumb");
    await page.click("#thumbs .thumb");
    await page.waitForSelector("#layer .bloom");
    await page.click("#vesselBtn");
    const clip = await page.$eval("#layer", el => el.style.clipPath);
    assert(/inset/.test(clip), "クリップ未適用: " + clip);
    const lineOn = await page.$eval("#mouthLine", el => el.classList.contains("on"));
    assert(lineOn, "口線が表示されていない");
    await page.click("#vesselBtn"); // 解除
    const clip2 = await page.$eval("#layer", el => el.style.clipPath);
    assert(!clip2, "クリップが解除されていない: " + clip2);
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
