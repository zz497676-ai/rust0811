const providerSelect = document.getElementById("provider");
const apiKeyInput = document.getElementById("apiKey");
const modelInput = document.getElementById("model");
const saveBtn = document.getElementById("save-btn");
const savedEl = document.getElementById("saved");

const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-5-20250929",
  deepseek: "deepseek-chat",
};

let store = { provider: "anthropic", anthropic: {}, deepseek: {} };

function fillFormForProvider(provider) {
  const s = store[provider] || {};
  apiKeyInput.value = s.apiKey || "";
  modelInput.value = s.model || "";
  modelInput.placeholder = `例如 ${DEFAULT_MODELS[provider]}`;
}

async function load() {
  const data = await chrome.storage.local.get(["provider", "anthropic", "deepseek"]);
  store.provider = data.provider || "anthropic";
  store.anthropic = data.anthropic || {};
  store.deepseek = data.deepseek || {};
  providerSelect.value = store.provider;
  fillFormForProvider(store.provider);
}

load();

// Switching providers just swaps which saved key/model is shown; it does not
// persist until "保存" is clicked, so unsaved edits to the previous provider
// are captured first.
providerSelect.addEventListener("change", () => {
  const previous = providerSelect.dataset.current || store.provider;
  store[previous] = { apiKey: apiKeyInput.value.trim(), model: modelInput.value.trim() };
  providerSelect.dataset.current = providerSelect.value;
  fillFormForProvider(providerSelect.value);
});
providerSelect.dataset.current = store.provider;

saveBtn.addEventListener("click", async () => {
  const provider = providerSelect.value;
  store[provider] = { apiKey: apiKeyInput.value.trim(), model: modelInput.value.trim() };
  store.provider = provider;
  await chrome.storage.local.set({
    provider: store.provider,
    anthropic: store.anthropic,
    deepseek: store.deepseek,
  });
  savedEl.textContent = "已保存";
  setTimeout(() => (savedEl.textContent = ""), 2000);
});
