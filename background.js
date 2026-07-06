// Service worker: owns the API key(s) and makes all model calls.
// Content scripts never see the key directly; they send text chunks here
// and receive back annotated HTML.

const MAX_TOKENS = 4096;

const PROVIDERS = {
  anthropic: {
    defaultModel: "claude-sonnet-4-5-20250929",
  },
  deepseek: {
    defaultModel: "deepseek-chat",
  },
};

const SYSTEM_PROMPT = `你是一个帮助读者快速抓住长文章重点的排版助手。
你会收到若干个用 <p id="N"> 包裹的段落，N 是段落编号。

请对每个段落做如下标注，然后原样输出（只允许插入下面列出的标签，不能引入其它标签或属性）：
- 用 <b>...</b> 包住这句话/短语里最关键的信息（核心事实、结论、数字、专有名词）。
- 在关键信息里，如果是全文最重要、最核心的论点/结论，额外用 <span class="arf-hi">...</span> 包住（可以和 <b> 嵌套使用）。
- 对背景信息、重复内容、次要细节，用 <span class="arf-lo">...</span> 包住，降低视觉权重。
- 对情绪明显偏正面/振奋的句子，用 <span class="arf-pos">...</span> 包住。
- 对情绪明显偏负面/警示/担忧的句子，用 <span class="arf-neg">...</span> 包住。

严格规则：
1. 绝对不能增删改动任何文字、标点或语序，只能插入上述标签。
2. 必须保留每个 <p id="N"> 外层包裹，且顺序、数量与输入完全一致。
3. 不允许输出 <p> 标签之外的任何解释、前后缀文字。
4. 不是每个段落都必须包含所有标签；没有明显重点/情绪的段落可以原样输出，不加标签。
5. 只使用 <b> 和 <span class="..."> 两种标签，class 只能是 arf-hi / arf-lo / arf-pos / arf-neg 之一。

直接输出标注后的 HTML，不要有任何其它内容。`;

async function getSettings() {
  const { provider, anthropic, deepseek } = await chrome.storage.local.get([
    "provider",
    "anthropic",
    "deepseek",
  ]);
  const activeProvider = provider || "anthropic";
  const providerSettings = (activeProvider === "deepseek" ? deepseek : anthropic) || {};
  return {
    provider: activeProvider,
    apiKey: providerSettings.apiKey || "",
    model: providerSettings.model || PROVIDERS[activeProvider].defaultModel,
  };
}

async function callAnthropic(apiKey, model, chunkHtml) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: chunkHtml }],
    }),
  });

  if (!response.ok) {
    const detail = await safeErrorDetail(response);
    return { ok: false, error: `Claude API 返回错误 (${response.status})：${detail}` };
  }

  const data = await response.json();
  const text = data?.content?.map((block) => block.text || "").join("") || "";
  if (!text.trim()) return { ok: false, error: "模型返回了空结果。" };
  return { ok: true, html: text };
}

async function callDeepSeek(apiKey, model, chunkHtml) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: chunkHtml },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await safeErrorDetail(response);
    return { ok: false, error: `DeepSeek API 返回错误 (${response.status})：${detail}` };
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) return { ok: false, error: "模型返回了空结果。" };
  return { ok: true, html: text };
}

async function safeErrorDetail(response) {
  try {
    const errBody = await response.json();
    return errBody?.error?.message || JSON.stringify(errBody);
  } catch {
    return "";
  }
}

async function analyzeChunk(chunkHtml) {
  const { provider, apiKey, model } = await getSettings();
  if (!apiKey) {
    return { ok: false, error: "尚未设置 API Key，请先在插件设置页填写。" };
  }

  try {
    if (provider === "deepseek") {
      return await callDeepSeek(apiKey, model, chunkHtml);
    }
    return await callAnthropic(apiKey, model, chunkHtml);
  } catch (err) {
    return { ok: false, error: `网络请求失败：${err.message}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ANALYZE_CHUNK") {
    analyzeChunk(message.payload).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  return false;
});
