import fs from "fs";
const data = JSON.parse(fs.readFileSync("./services/session/deepseek_accounts.json", "utf8"));

if (!Array.isArray(data) || !data.length) {
  console.log("Empty or not an array");
  process.exit(1);
}

console.log(
  "Account IDs:",
  data.map((a) => a.id)
);
data.forEach((acc, i) => {
  if (acc.id?.startsWith("deepseek_")) {
    console.log(`\n=== Account ${i}: ${acc.id} ===`);
    console.log("authData:", JSON.stringify(acc.authData || {}, null, 2).slice(0, 300));

    const lsKeys = Object.keys(acc.storage?.ls || {});
    if (lsKeys.length) {
      console.log("\nlocalStorage keys:");
      console.log(lsKeys.join("\n"));
    }

    // Search for wasm URLs in feature store entries
    const entries = acc.storage?.ls?.__ds_remote_feature_store_model?.entries;
    if (entries) {
      console.log("\n=== Feature store entry keys ===");
      Object.entries(entries).forEach(([k, v]) => {
        const valStr = JSON.stringify(v);
        // Check if contains wasm or pow related data
        if (/wasm|pow|challenge/.test(valStr)) {
          console.log(`${k}: ${valStr.slice(0, 200)}`);
        }
      });
    }
  }
});
