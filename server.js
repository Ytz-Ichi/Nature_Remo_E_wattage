const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3210;
const NATURE_TOKEN = process.env.NATURE_REMO_TOKEN;

// 契約アンペア（未設定・不正値なら 30A）
const rawAmp = parseInt(process.env.CONTRACT_AMP, 10);
const CONTRACT_AMP = Number.isFinite(rawAmp) && rawAmp > 0 ? rawAmp : 30;
const THRESHOLD_W = Math.floor(CONTRACT_AMP * 100 * 0.85);

if (!NATURE_TOKEN) {
  console.error("[ERROR] 環境変数 NATURE_REMO_TOKEN が設定されていません。");
  console.error("  PowerShell: $env:NATURE_REMO_TOKEN = 'YOUR_TOKEN'");
  process.exit(1);
}

console.log(`[設定] 契約アンペア: ${CONTRACT_AMP}A / 警告閾値: ${THRESHOLD_W}W`);

app.use(express.static(path.join(__dirname, "public")));

// ---------- GET /config ----------
// フロントエンドに閾値設定を返す（トークン等は含めない）
app.get("/config", (_req, res) => {
  res.json({
    contractAmp: CONTRACT_AMP,
    thresholdW: THRESHOLD_W,
  });
});

// ---------- GET /power ----------
// Nature Remo Cloud API から瞬時電力(W)を取得
app.get("/power", async (_req, res) => {
  try {
    const response = await fetch("https://api.nature.global/1/appliances", {
      headers: { Authorization: `Bearer ${NATURE_TOKEN}` },
    });

    if (!response.ok) {
      const status = response.status;

      if (status === 401) {
        return res.status(401).json({ error: "認証エラー: トークンが無効です" });
      }

      // --- 429 レート制限 ---
      if (status === 429) {
        const resetEpoch = response.headers.get("x-rate-limit-reset");
        return res.status(429).json({
          error: "レート制限: API呼び出し上限に達しました",
          rateLimitReset: resetEpoch ? Number(resetEpoch) : null,
        });
      }

      return res.status(status).json({ error: `API エラー (HTTP ${status})` });
    }

    const appliances = await response.json();

    // smart_meter を持つアプライアンスを検索
    const smartMeterAppliance = appliances.find(
      (a) => a.smart_meter != null
    );

    if (!smartMeterAppliance) {
      return res.status(404).json({ error: "スマートメーターが見つかりません" });
    }

    const props = smartMeterAppliance.smart_meter.echonetlite_properties;
    if (!Array.isArray(props)) {
      return res.status(500).json({ error: "echonetlite_properties が取得できません" });
    }

    // EPC 231 (0xE7) = 瞬時電力(W)
    const powerProp = props.find((p) => p.epc === 231);

    if (!powerProp) {
      console.log(
        "[DEBUG] 取得できた EPC 一覧:",
        props.map((p) => ({ epc: p.epc, name: p.name }))
      );
      return res.status(404).json({ error: "瞬時電力(EPC=231)が見つかりません" });
    }

    const watt = parseInt(powerProp.val, 10);
    if (isNaN(watt)) {
      return res.json({ watt: null, updated_at: powerProp.updated_at });
    }

    res.json({ watt, updated_at: powerProp.updated_at });
  } catch (err) {
    console.error("[ERROR] API 取得失敗:", err.message);
    res.status(500).json({ error: `通信エラー: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`[Nature Remo E Wattage] http://localhost:${PORT} で起動しました`);
});
