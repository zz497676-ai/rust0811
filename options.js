const apiKeyInput = document.getElementById("apiKey");
const modelInput = document.getElementById("model");
const saveBtn = document.getElementById("save-btn");
const savedEl = document.getElementById("saved");

async function load() {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  if (apiKey) apiKeyInput.value = apiKey;
  if (model) modelInput.value = model;
}

load();

saveBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
  });
  savedEl.textContent = "已保存";
  setTimeout(() => (savedEl.textContent = ""), 2000);
});
