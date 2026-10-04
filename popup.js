document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('status-badge');
  const detectedTitle = document.getElementById('detected-title');
  const detectedId = document.getElementById('detected-id');
  const exportBtn = document.getElementById('export-btn');
  const notChatgptAlert = document.getElementById('not-chatgpt-alert');
  const openChatgptBtn = document.getElementById('open-chatgpt-btn');
  const manualUrlInput = document.getElementById('manual-url');
  const progressContainer = document.getElementById('progress-container');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressText = document.getElementById('progress-text');

  let activeTab = null;
  let activeConvId = null;
  let activeProjectId = null;

  // 1. Check current tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];

    if (activeTab && activeTab.url) {
      const url = activeTab.url;
      const isChatGPT = url.includes('chatgpt.com') || url.includes('chat.openai.com');

      if (isChatGPT) {
        statusBadge.textContent = 'Ready';
        statusBadge.className = 'badge badge-ready';

        const convMatch = url.match(/\/c\/([a-zA-Z0-9-]+)/);
        const projMatch = url.match(/\/g\/([a-zA-Z0-9-]+)/);

        if (convMatch) {
          activeConvId = convMatch[1];
          detectedId.textContent = `ID: ${activeConvId}`;
          detectedTitle.textContent = activeTab.title ? activeTab.title.replace(' - ChatGPT', '').replace('ChatGPT', 'Active Conversation') : 'Active Conversation';
          exportBtn.disabled = false;
        } else {
          detectedTitle.textContent = 'ChatGPT Home (Open a specific chat)';
          detectedId.textContent = 'No conversation selected';
          exportBtn.disabled = true;
        }

        if (projMatch) {
          activeProjectId = projMatch[1];
        }
      } else {
        showNotChatGPT();
      }
    } else {
      showNotChatGPT();
    }
  } catch (err) {
    console.error('Tab query error:', err);
    showNotChatGPT();
  }

  function showNotChatGPT() {
    statusBadge.textContent = 'Inactive';
    statusBadge.className = 'badge badge-warning';
    notChatgptAlert.classList.remove('hidden');
    detectedTitle.textContent = 'No ChatGPT tab active';
    detectedId.textContent = 'Open chatgpt.com to export';
    exportBtn.disabled = true;
  }

  openChatgptBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chatgpt.com' });
  });

  manualUrlInput?.addEventListener('input', () => {
    const val = manualUrlInput.value.trim();
    if (val.length > 5) {
      exportBtn.disabled = false;
      detectedTitle.textContent = 'Manual Target Selected';
      detectedId.textContent = val;
    } else if (!activeConvId) {
      exportBtn.disabled = true;
    }
  });

  // 2. Trigger Export
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    progressContainer.classList.remove('hidden');
    progressBarFill.style.width = '20%';
    progressText.textContent = 'Connecting to ChatGPT session...';

    const selectedFormat = document.querySelector('input[name="export-format"]:checked')?.value || 'conversation';
    const optThoughts = document.getElementById('opt-thoughts').checked;
    const optTools = document.getElementById('opt-tools').checked;
    const optCitations = document.getElementById('opt-citations').checked;

    let targetConvId = activeConvId;
    let targetProjectId = activeProjectId;

    const manualVal = manualUrlInput.value.trim();
    if (manualVal) {
      const c = manualVal.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1] || manualVal;
      const p = manualVal.match(/\/g\/([a-zA-Z0-9-]+)/)?.[1];
      targetConvId = c;
      if (p) targetProjectId = p;
    }

    try {
      progressBarFill.style.width = '45%';
      progressText.textContent = 'Fetching conversation trajectory...';

      // Execute extraction directly inside active ChatGPT tab
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: inTabExtractor,
        args: [{
          targetConvId,
          targetProjectId,
          format: selectedFormat,
          includeThoughts: optThoughts,
          includeTools: optTools,
          includeCitations: optCitations
        }]
      });

      if (!results || !results[0] || !results[0].result) {
        throw new Error('Extraction failed to return data.');
      }

      const res = results[0].result;
      if (res.error) {
        throw new Error(res.error);
      }

      progressBarFill.style.width = '85%';
      progressText.textContent = `Formatting ${res.total_messages} messages...`;

      // Native HTML5 download without needing chrome.downloads permission
      const blob = new Blob([res.content], { type: res.mimeType });
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);

      progressBarFill.style.width = '100%';
      progressText.textContent = `✅ Saved as ${res.filename}!`;
      statusBadge.textContent = 'Success';
      statusBadge.className = 'badge badge-ready';
      setTimeout(() => { exportBtn.disabled = false; }, 2000);

    } catch (err) {
      console.error('Export error:', err);
      progressBarFill.style.width = '100%';
      progressBarFill.style.backgroundColor = 'var(--error)';
      progressText.textContent = `❌ ${err.message || 'Export failed'}`;
      exportBtn.disabled = false;
    }
  });
});


/**
 * Executed in the context of the active ChatGPT page (Same-Origin Fetch, zero host_permissions needed)
 */
async function inTabExtractor(options) {
  const {
    targetConvId,
    targetProjectId,
    format,
    includeThoughts,
    includeTools,
    includeCitations
  } = options;

  let token = null;
  try {
    const sessionRes = await fetch('/api/auth/session');
    if (sessionRes.ok) {
      const session = await sessionRes.json();
      token = session.accessToken;
    }
  } catch (e) {}

  const headers = { 'accept': '*/*' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (targetProjectId) headers['chatgpt-project-id'] = targetProjectId;

  let mapping = {};
  let title = "chatgpt_conversation";
  let currentNode = null;

  // 1. Try single conversation tree endpoint
  try {
    const res = await (await fetch(`/backend-api/conversation/${targetConvId}`, {
      headers,
      credentials: 'include'
    })).json();
    if (res?.mapping) {
      mapping = res.mapping;
      title = res.title || title;
      currentNode = res.current_node;
    }
  } catch (err) {}

  // 2. Fallback to pagination
  if (!mapping || Object.keys(mapping).length === 0) {
    const init = await (await fetch(`/backend-api/conversations/${targetConvId}?include_has_versions=true&num_turns=20`, {
      headers,
      credentials: 'include'
    })).json();
    if (!init || init.error) throw new Error(init?.error?.message || 'Failed to fetch conversation');
    title = init.title || title;
    currentNode = init.current_node;
    Object.assign(mapping, init.mapping || {});

    let page = 0;
    while (page < 50) {
      page++;
      let earliestId = null, earliestTime = Infinity;
      for (const [id, node] of Object.entries(mapping)) {
        if (node.message?.create_time < earliestTime && node.parent && !mapping[node.parent]) {
          earliestTime = node.message.create_time;
          earliestId = id;
        }
      }
      if (!earliestId) break;

      const prev = await (await fetch(`/backend-api/conversations/${targetConvId}/messages?before=${earliestId}&include_has_versions=true&num_turns=20`, {
        headers,
        credentials: 'include'
      })).json();
      if (!prev?.mapping) break;

      let added = 0;
      for (const k of Object.keys(prev.mapping)) {
        if (!mapping[k]) { mapping[k] = prev.mapping[k]; added++; }
      }
      if (added === 0) break;
    }
  }

  // Raw mode export
  if (format === 'raw') {
    const rawData = JSON.stringify({ id: targetConvId, title, mapping }, null, 2);
    const safeTitle = title.replace(/[^a-z0-9_-]/gi, '_').toLowerCase().slice(0, 40);
    return {
      content: rawData,
      filename: `${safeTitle}_raw.json`,
      mimeType: 'application/json',
      total_messages: Object.keys(mapping).length
    };
  }

  // 3. Trace linear active path
  const leaves = Object.keys(mapping).filter(id => !mapping[id].children?.length);
  let curr = currentNode || leaves[leaves.length - 1];
  const linearNodes = [];
  const visited = new Set();
  while (curr && !visited.has(curr) && mapping[curr]) {
    visited.add(curr);
    if (mapping[curr].message) linearNodes.unshift(mapping[curr].message);
    curr = mapping[curr].parent;
  }

  // 4. Transform into rich agent messages
  const messages = [];
  let currentThought = [];
  let lastCallId = null;

  for (const msg of linearNodes) {
    const role = msg.author?.role;
    const content = msg.content || {};
    const metadata = msg.metadata || {};
    const recipient = msg.recipient;
    const contentType = content.content_type;

    // Collect thoughts
    if (includeThoughts && (contentType === 'thoughts' || contentType === 'reasoning_recap')) {
      (content.thoughts || []).forEach(t => {
        const text = typeof t === 'string' ? t : (t.content || t.summary || '');
        if (text) currentThought.push(text);
      });
      if (content.content) currentThought.push(content.content);
      continue;
    }

    let text = "";
    if (Array.isArray(content.parts)) {
      text = content.parts.map(p => (typeof p === 'string' ? p : p?.text || JSON.stringify(p))).join('\n');
    } else if (content.text) {
      text = content.text;
    }

    // Ignore recipient: 'all' (human broadcast)
    const isToolCall = includeTools && (Boolean(recipient && recipient !== 'all') || (contentType === 'code' && role === 'assistant'));

    if (!text && !isToolCall && role !== 'tool') continue;

    if (role === 'user') {
      messages.push({
        role: 'user',
        content: text,
        attachments: metadata.attachments,
        created_at: msg.create_time
      });
      currentThought = [];
      lastCallId = null;
    } else if (role === 'assistant') {
      if (isToolCall) {
        const toolName = (recipient && recipient !== 'all') ? recipient : 'python';
        const callId = `call_${msg.id.slice(0, 16)}`;
        lastCallId = callId;
        let args = {};
        try { args = contentType === 'code' ? { code: text } : JSON.parse(text); } catch { args = { input: text }; }

        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name: toolName, arguments: JSON.stringify(args) }
          }],
          thought: (includeThoughts && currentThought.length) ? currentThought.join('\n') : undefined,
          created_at: msg.create_time,
          message_id: msg.id
        });
        currentThought = [];
      } else {
        messages.push({
          role: 'assistant',
          content: text,
          thought: (includeThoughts && currentThought.length) ? currentThought.join('\n') : undefined,
          citations: (includeCitations && metadata.citations) ? metadata.citations : undefined,
          created_at: msg.create_time,
          message_id: msg.id
        });
        currentThought = [];
        lastCallId = null;
      }
    } else if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: lastCallId || `call_${msg.id.slice(0, 16)}`,
        name: msg.author?.name || 'tool',
        content: text,
        created_at: msg.create_time
      });
    }
  }

  const safeTitle = title.replace(/[^a-z0-9_-]/gi, '_').toLowerCase().slice(0, 40);

  if (format === 'steps') {
    const stepsLines = messages.map((m, idx) => JSON.stringify({
      conversation_id: targetConvId,
      title,
      step: idx + 1,
      ...m
    })).join('\n') + '\n';

    return {
      content: stepsLines,
      filename: `${safeTitle}_steps.jsonl`,
      mimeType: 'application/jsonl',
      total_messages: messages.length
    };
  }

  // Default: multi-turn agent dataset format
  const convRecord = {
    id: targetConvId,
    title,
    total_messages: messages.length,
    messages
  };

  return {
    content: JSON.stringify(convRecord) + '\n',
    filename: `${safeTitle}_agent.jsonl`,
    mimeType: 'application/jsonl',
    total_messages: messages.length
  };
}
