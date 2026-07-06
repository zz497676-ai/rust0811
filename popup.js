const runBtn = document.getElementById("run-btn");
const statusEl = document.getElementById("status");
const warningEl = document.getElementById("warning");
const openOptionsLink = document.getElementById("open-options");

openOptionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function refreshWarning() {
  const { apiKey } = await chrome.storage.local.get(["apiKey"]);
  warningEl.style.display = apiKey ? "none" : "block";
}

refreshWarning();

runBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  runBtn.disabled = true;
  statusEl.textContent = "正在注入并分析文章...";

  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    statusEl.textContent = "已开始处理，页面右下角会显示进度。";
  } catch (err) {
    statusEl.textContent = `注入失败：${err.message}`;
  } finally {
    runBtn.disabled = false;
  }
});
